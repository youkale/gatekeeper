import picomatch from "picomatch";

export type LaneState = "pass" | "fail" | "pending";

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export type ExtensionFields = {
	[key: `x-${string}`]: unknown;
};

export interface RegexMatch extends ExtensionFields {
	pattern: string;
	ignore_case?: boolean;
}

export type BodyMatch = string | RegexMatch;

export interface HumanApprovalLaneDefinition extends ExtensionFields {
	type: "human-approval";
	min: number;
	fresh: boolean;
}

export interface ReviewLanePassDefinition extends ExtensionFields {
	state: ReviewState;
	body_matches?: BodyMatch;
	ignore_case?: boolean;
}

export interface ReviewLaneDefinition extends ExtensionFields {
	type: "review";
	author: string;
	pass: ReviewLanePassDefinition;
}

export interface CheckRunLaneDefinition extends ExtensionFields {
	type: "check-run";
	selector?: "check-run" | "status";
	name: string;
	pass?: string[];
}

export interface CommentScanLaneDefinition extends ExtensionFields {
	type: "comment-scan";
	author: string;
	body_matches: BodyMatch;
	ignore_case?: boolean;
}

export type LaneDefinition =
	| HumanApprovalLaneDefinition
	| ReviewLaneDefinition
	| CheckRunLaneDefinition
	| CommentScanLaneDefinition;

export type LaneConfig = LaneDefinition & { lane: string };

export interface GitHubUserPayload {
	login: string;
	type?: string;
}

export interface GitHubReviewPayload {
	id: number;
	user: GitHubUserPayload | null;
	body: string | null;
	state: string;
	commit_id: string | null;
	submitted_at: string | null;
}

export interface GitHubCheckRunPayload {
	id: number;
	name: string;
	head_sha?: string;
	status: string;
	conclusion: string | null;
	started_at: string | null;
	completed_at: string | null;
}

export interface GitHubStatusPayload {
	id: number;
	sha?: string;
	state: string;
	context: string;
	created_at: string;
	updated_at: string;
}

export interface GitHubCommentPayload {
	id: number;
	user: GitHubUserPayload | null;
	body: string | null;
	created_at: string;
	updated_at: string;
}

export interface LaneEvaluationData {
	reviews: GitHubReviewPayload[];
	checkRuns: GitHubCheckRunPayload[];
	statuses: GitHubStatusPayload[];
	comments: GitHubCommentPayload[];
	headSha: string;
	headPushedAt: string | null;
}

export interface LaneResult {
	lane: string;
	state: LaneState;
	evidence: string;
}

export interface MOfNResult {
	state: LaneState;
	minimum: number;
	pass: number;
	fail: number;
	pending: number;
}

const terminalFailures = new Set(["failure", "timed_out", "cancelled", "action_required", "error"]);

function isBot(login: string): boolean {
	return login.toLowerCase().includes("[bot]");
}

function timestamp(value: string | null | undefined): number {
	if (!value) {
		return Number.NEGATIVE_INFINITY;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function isLater(
	left: { id: number },
	right: { id: number },
	leftTimestamp: string | null | undefined,
	rightTimestamp: string | null | undefined,
): boolean {
	const leftTime = timestamp(leftTimestamp);
	const rightTime = timestamp(rightTimestamp);
	return leftTime > rightTime || (leftTime === rightTime && left.id > right.id);
}

function matchesGlob(value: string, pattern: string): boolean {
	if (value === pattern) {
		return true;
	}
	try {
		return picomatch.isMatch(value, pattern, { dot: true });
	} catch {
		return false;
	}
}

function regexParts(bodyMatch: BodyMatch, fallbackIgnoreCase = false): { pattern: string; ignoreCase: boolean } {
	if (typeof bodyMatch === "string") {
		return { pattern: bodyMatch, ignoreCase: fallbackIgnoreCase };
	}
	return { pattern: bodyMatch.pattern, ignoreCase: bodyMatch.ignore_case ?? fallbackIgnoreCase };
}

function matchesBody(body: string | null, bodyMatch: BodyMatch, fallbackIgnoreCase = false): boolean {
	const { pattern, ignoreCase } = regexParts(bodyMatch, fallbackIgnoreCase);
	try {
		return new RegExp(pattern, ignoreCase ? "i" : undefined).test(body ?? "");
	} catch {
		return false;
	}
}

function latestHumanDecisionsByLogin(reviews: GitHubReviewPayload[]): Map<string, GitHubReviewPayload> {
	const latest = new Map<string, GitHubReviewPayload>();
	for (const review of reviews) {
		const login = review.user?.login;
		if (
			!login ||
			(review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED")
		) {
			continue;
		}
		const previous = latest.get(login);
		if (!previous || isLater(review, previous, review.submitted_at, previous.submitted_at)) {
			latest.set(login, review);
		}
	}
	return latest;
}

function evaluateHumanApproval(
	config: HumanApprovalLaneDefinition & { lane: string },
	data: LaneEvaluationData,
): LaneResult {
	const humanReviews = data.reviews.filter((review) => review.user?.login && !isBot(review.user.login));
	const latestDecisions = [...latestHumanDecisionsByLogin(humanReviews).values()].filter(
		(review) => review.state !== "DISMISSED",
	);
	const changesRequested = latestDecisions
		.filter((review) => review.state === "CHANGES_REQUESTED")
		.map((review) => review.user?.login)
		.filter((login): login is string => login !== undefined)
		.sort();
	if (changesRequested.length > 0) {
		return {
			lane: config.lane,
			state: "fail",
			evidence: `changes requested by ${changesRequested.join(", ")}`,
		};
	}

	const approvals = latestDecisions.filter(
		(review) => review.state === "APPROVED" && (!config.fresh || review.commit_id === data.headSha),
	).length;
	if (approvals >= config.min) {
		return {
			lane: config.lane,
			state: "pass",
			evidence: `${approvals} human approval(s), minimum ${config.min}`,
		};
	}

	return {
		lane: config.lane,
		state: "pending",
		evidence: `${approvals}/${config.min} human approval(s)${config.fresh ? " on the head commit" : ""}`,
	};
}

function evaluateReview(config: ReviewLaneDefinition & { lane: string }, data: LaneEvaluationData): LaneResult {
	const matching = data.reviews.filter((review) => {
		const login = review.user?.login;
		return login !== undefined && matchesGlob(login, config.author);
	});
	let latest: GitHubReviewPayload | undefined;
	for (const review of matching) {
		if (!latest || isLater(review, latest, review.submitted_at, latest.submitted_at)) {
			latest = review;
		}
	}

	if (!latest) {
		return { lane: config.lane, state: "pending", evidence: `no review from ${config.author}` };
	}

	const login = latest.user?.login ?? config.author;
	if (latest.state !== config.pass.state) {
		return {
			lane: config.lane,
			state: "fail",
			evidence: `${login} latest review is ${latest.state}, expected ${config.pass.state}`,
		};
	}
	if (
		config.pass.body_matches !== undefined &&
		!matchesBody(latest.body, config.pass.body_matches, config.pass.ignore_case)
	) {
		return {
			lane: config.lane,
			state: "fail",
			evidence: `${login} latest review body did not match the required text`,
		};
	}

	return {
		lane: config.lane,
		state: "pass",
		evidence: `${login} latest review is ${latest.state}${config.pass.body_matches ? " (text-matched)" : ""}`,
	};
}

function latestCheckRunsByName(checkRuns: GitHubCheckRunPayload[]): GitHubCheckRunPayload[] {
	const latest = new Map<string, GitHubCheckRunPayload>();
	for (const checkRun of checkRuns) {
		const previous = latest.get(checkRun.name);
		const checkTime = checkRun.completed_at ?? checkRun.started_at;
		const previousTime = previous?.completed_at ?? previous?.started_at;
		if (!previous || isLater(checkRun, previous, checkTime, previousTime)) {
			latest.set(checkRun.name, checkRun);
		}
	}
	return [...latest.values()];
}

function latestStatusesByContext(statuses: GitHubStatusPayload[]): GitHubStatusPayload[] {
	const latest = new Map<string, GitHubStatusPayload>();
	for (const status of statuses) {
		const previous = latest.get(status.context);
		if (!previous || isLater(status, previous, status.updated_at, previous.updated_at)) {
			latest.set(status.context, status);
		}
	}
	return [...latest.values()];
}

function foldCheckStates(
	lane: string,
	selector: string,
	states: Array<{ name: string; value: string | null; state: LaneState }>,
): LaneResult {
	if (states.length === 0) {
		return { lane, state: "pending", evidence: `no matching ${selector}` };
	}
	const failed = states.filter(({ state }) => state === "fail");
	if (failed.length > 0) {
		return {
			lane,
			state: "fail",
			evidence: failed.map(({ name, value }) => `${name}=${value}`).join(", "),
		};
	}
	const pending = states.filter(({ state }) => state === "pending");
	if (pending.length > 0) {
		return {
			lane,
			state: "pending",
			evidence: pending.map(({ name, value }) => `${name}=${value ?? "in_progress"}`).join(", "),
		};
	}
	return { lane, state: "pass", evidence: states.map(({ name, value }) => `${name}=${value}`).join(", ") };
}

function evaluateCheckRun(config: CheckRunLaneDefinition & { lane: string }, data: LaneEvaluationData): LaneResult {
	const pass = new Set((config.pass ?? ["success"]).map((value) => value.toLowerCase()));
	const selector = config.selector ?? "check-run";
	if (selector === "status") {
		const statuses = latestStatusesByContext(data.statuses)
			.filter((status) => matchesGlob(status.context, config.name))
			.map((status) => ({
				name: status.context,
				value: status.state,
				state: pass.has(status.state.toLowerCase())
					? ("pass" as const)
					: terminalFailures.has(status.state.toLowerCase())
						? ("fail" as const)
						: ("pending" as const),
			}));
		return foldCheckStates(config.lane, "commit status", statuses);
	}

	const checkRuns = latestCheckRunsByName(data.checkRuns)
		.filter((checkRun) => matchesGlob(checkRun.name, config.name))
		.map((checkRun) => ({
			name: checkRun.name,
			value: checkRun.conclusion,
			state:
				checkRun.conclusion !== null && pass.has(checkRun.conclusion.toLowerCase())
					? ("pass" as const)
					: checkRun.conclusion !== null && terminalFailures.has(checkRun.conclusion.toLowerCase())
						? ("fail" as const)
						: ("pending" as const),
		}));
	return foldCheckStates(config.lane, "check run", checkRuns);
}

function evaluateCommentScan(
	config: CommentScanLaneDefinition & { lane: string },
	data: LaneEvaluationData,
): LaneResult {
	const match = data.comments.find((comment) => {
		const login = comment.user?.login;
		return (
			login !== undefined &&
			matchesGlob(login, config.author) &&
			matchesBody(comment.body, config.body_matches, config.ignore_case)
		);
	});
	if (!match) {
		return { lane: config.lane, state: "pending", evidence: `no text match from ${config.author}` };
	}
	return {
		lane: config.lane,
		state: "pass",
		evidence: `${match.user?.login ?? config.author} comment ${match.id} matched (text-matched)`,
	};
}

export function evaluateLane(config: LaneConfig, data: LaneEvaluationData): LaneResult {
	switch (config.type) {
		case "human-approval":
			return evaluateHumanApproval(config, data);
		case "review":
			return evaluateReview(config, data);
		case "check-run":
			return evaluateCheckRun(config, data);
		case "comment-scan":
			return evaluateCommentScan(config, data);
	}
}

export function evaluateLanes(input: { lanes: LaneConfig[]; data: LaneEvaluationData }): LaneResult[] {
	return input.lanes.map((lane) => evaluateLane(lane, input.data));
}

export function evaluateMOfN(results: LaneResult[], minimum: number): MOfNResult {
	const pass = results.filter((result) => result.state === "pass").length;
	const fail = results.filter((result) => result.state === "fail").length;
	const pending = results.length - pass - fail;
	const state: LaneState = pass >= minimum ? "pass" : pass + pending < minimum ? "fail" : "pending";
	return { state, minimum, pass, fail, pending };
}

export const combineLaneResults = evaluateMOfN;
