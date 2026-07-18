/**
 * GitHub REST provider. All GitHub network access is isolated in this module;
 * callers receive REST-v3-shaped data and can keep evaluation code pure.
 */

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PULL_REQUEST_FILES = 3_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_PAGINATION_PAGES = 1_000;
const MAX_PAGINATED_ITEMS = DEFAULT_PAGE_SIZE * MAX_PAGINATION_PAGES;

export type InfraErrorKind = "configuration" | "network" | "http" | "json" | "payload";

export interface InfraErrorOptions {
	kind: InfraErrorKind;
	operation: string;
	method?: string;
	url?: string;
	status?: number;
	responseBody?: string;
	cause?: unknown;
}

/** A structured infrastructure fault which command layers must handle fail-open. */
export class InfraError extends Error {
	readonly reason: string;
	readonly kind: InfraErrorKind;
	readonly operation: string;
	readonly method?: string;
	readonly url?: string;
	readonly status?: number;
	readonly responseBody?: string;

	constructor(reason: string, options: InfraErrorOptions) {
		super(reason);
		this.name = "InfraError";
		this.reason = reason;
		this.kind = options.kind;
		this.operation = options.operation;
		this.method = options.method;
		this.url = options.url;
		this.status = options.status;
		this.responseBody = options.responseBody;
		if (options.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

export interface GitHubUser {
	login: string;
	id?: number;
	type?: string;
}

export interface GitHubLabel {
	id?: number;
	name: string;
	color?: string;
	description?: string | null;
}

export interface GitHubPullRequestRef {
	ref: string;
	sha: string;
	repo?: {
		full_name?: string;
	} | null;
}

export interface GitHubPullRequest {
	number: number;
	body: string | null;
	user: GitHubUser | null;
	head: GitHubPullRequestRef;
	base: GitHubPullRequestRef;
	labels: GitHubLabel[];
	created_at?: string;
	updated_at?: string;
	html_url?: string;
}

export interface GitHubIssue {
	number: number;
	title: string;
	body: string | null;
	user: GitHubUser | null;
	labels: GitHubLabel[];
	created_at?: string;
	updated_at?: string;
	html_url?: string;
}

export interface GitHubPullRequestFile {
	sha: string;
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
	blob_url: string;
	raw_url: string;
	contents_url: string;
	patch?: string;
	previous_filename?: string;
}

export interface GitHubPullRequestReview {
	id: number;
	user: GitHubUser | null;
	body: string | null;
	state: string;
	commit_id: string | null;
	submitted_at: string | null;
	html_url?: string;
}

export interface GitHubIssueComment {
	id: number;
	user: GitHubUser | null;
	body: string | null;
	created_at: string;
	updated_at: string;
	html_url?: string;
}

export interface GitHubCheckRun {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	details_url?: string | null;
	app?: {
		slug?: string;
	} | null;
}

export interface GitHubCommitStatus {
	id: number;
	context: string;
	state: string;
	description: string | null;
	target_url: string | null;
	created_at?: string;
	updated_at?: string;
	creator?: GitHubUser | null;
}

export interface GitHubRequiredStatusCheck {
	context: string;
	app_id: number | null;
}

export interface AvailableRequiredChecks {
	available: true;
	contexts: string[];
	checks: GitHubRequiredStatusCheck[];
}

export interface UnavailableRequiredChecks {
	available: false;
	reason: "forbidden" | "not-found";
	status: 403 | 404;
	message: string;
}

export type RequiredChecksResult = AvailableRequiredChecks | UnavailableRequiredChecks;

export type GitHubFetch = typeof globalThis.fetch;

export interface GitHubProviderOptions {
	/** Repository identity in `owner/name` form. */
	repo: string;
	/** Defaults to GITHUB_TOKEN. Omit or pass an empty string for unauthenticated requests. */
	token?: string;
	/** Defaults to GITHUB_API_URL, then https://api.github.com. */
	apiBase?: string;
	/** Injectable for fixture-backed tests. */
	fetch?: GitHubFetch;
	/** Injectable so retry behavior can be tested without real delays. */
	sleep?: (milliseconds: number) => Promise<void>;
	maxRetries?: number;
	retryDelayMs?: number;
}

interface RequestOptions {
	method?: "GET" | "POST" | "PATCH" | "DELETE";
	body?: unknown;
	operation: string;
}

interface CheckRunsResponse {
	total_count: number;
	check_runs: GitHubCheckRun[];
}

interface CombinedStatusResponse {
	total_count: number;
	statuses: GitHubCommitStatus[];
}

interface RequiredChecksResponse {
	contexts: string[];
	checks: GitHubRequiredStatusCheck[];
}

class PayloadValidationError extends Error {}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function responseExcerpt(body: string): string {
	const compact = body.replace(/\s+/g, " ").trim();
	return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadType(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	return typeof value;
}

function invalidPayload(path: string, expected: string, value: unknown): never {
	throw new PayloadValidationError(`${path}: expected ${expected}, got ${payloadType(value)}`);
}

function recordValue(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) {
		return invalidPayload(path, "object", value);
	}
	return value;
}

function arrayValue(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) {
		return invalidPayload(path, "array", value);
	}
	return value;
}

function stringValue(value: unknown, path: string, nonEmpty = false): string {
	if (typeof value !== "string" || (nonEmpty && value.length === 0)) {
		return invalidPayload(path, nonEmpty ? "non-empty string" : "string", value);
	}
	return value;
}

function nullableStringValue(value: unknown, path: string): string | null {
	if (value === null) {
		return null;
	}
	return stringValue(value, path);
}

function integerValue(value: unknown, path: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		return invalidPayload(path, `safe integer >= ${minimum}`, value);
	}
	return value as number;
}

function finiteNumberValue(value: unknown, path: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		return invalidPayload(path, `finite number >= ${minimum}`, value);
	}
	return value;
}

function optionalStringValue(value: unknown, path: string): void {
	if (value !== undefined) {
		stringValue(value, path);
	}
}

function optionalNullableStringValue(value: unknown, path: string): void {
	if (value !== undefined) {
		nullableStringValue(value, path);
	}
}

function validateUser(value: unknown, path: string): GitHubUser | null {
	if (value === null) {
		return null;
	}
	const user = recordValue(value, path);
	stringValue(user.login, `${path}.login`, true);
	if (user.id !== undefined) {
		integerValue(user.id, `${path}.id`, 1);
	}
	optionalStringValue(user.type, `${path}.type`);
	return value as GitHubUser;
}

function validateLabel(value: unknown, path: string): GitHubLabel {
	const label = recordValue(value, path);
	stringValue(label.name, `${path}.name`, true);
	if (label.id !== undefined) {
		integerValue(label.id, `${path}.id`, 1);
	}
	optionalStringValue(label.color, `${path}.color`);
	optionalNullableStringValue(label.description, `${path}.description`);
	return value as GitHubLabel;
}

function validatePullRequestRef(value: unknown, path: string): GitHubPullRequestRef {
	const ref = recordValue(value, path);
	stringValue(ref.ref, `${path}.ref`, true);
	stringValue(ref.sha, `${path}.sha`, true);
	return value as unknown as GitHubPullRequestRef;
}

function validatePullRequest(value: unknown, path: string): GitHubPullRequest {
	const pullRequest = recordValue(value, path);
	integerValue(pullRequest.number, `${path}.number`, 1);
	nullableStringValue(pullRequest.body, `${path}.body`);
	validateUser(pullRequest.user, `${path}.user`);
	validatePullRequestRef(pullRequest.head, `${path}.head`);
	validatePullRequestRef(pullRequest.base, `${path}.base`);
	for (const [index, label] of arrayValue(pullRequest.labels, `${path}.labels`).entries()) {
		validateLabel(label, `${path}.labels[${index}]`);
	}
	optionalStringValue(pullRequest.created_at, `${path}.created_at`);
	optionalStringValue(pullRequest.updated_at, `${path}.updated_at`);
	optionalStringValue(pullRequest.html_url, `${path}.html_url`);
	return value as unknown as GitHubPullRequest;
}

function validateIssue(value: unknown, path: string): GitHubIssue {
	const issue = recordValue(value, path);
	integerValue(issue.number, `${path}.number`, 1);
	stringValue(issue.title, `${path}.title`, true);
	nullableStringValue(issue.body, `${path}.body`);
	validateUser(issue.user, `${path}.user`);
	for (const [index, label] of arrayValue(issue.labels, `${path}.labels`).entries()) {
		validateLabel(label, `${path}.labels[${index}]`);
	}
	optionalStringValue(issue.created_at, `${path}.created_at`);
	optionalStringValue(issue.updated_at, `${path}.updated_at`);
	optionalStringValue(issue.html_url, `${path}.html_url`);
	return value as unknown as GitHubIssue;
}

function validatePullRequestFile(value: unknown, path: string): GitHubPullRequestFile {
	const file = recordValue(value, path);
	stringValue(file.sha, `${path}.sha`, true);
	stringValue(file.filename, `${path}.filename`, true);
	stringValue(file.status, `${path}.status`, true);
	finiteNumberValue(file.additions, `${path}.additions`);
	finiteNumberValue(file.deletions, `${path}.deletions`);
	finiteNumberValue(file.changes, `${path}.changes`);
	stringValue(file.blob_url, `${path}.blob_url`);
	stringValue(file.raw_url, `${path}.raw_url`);
	stringValue(file.contents_url, `${path}.contents_url`);
	optionalStringValue(file.patch, `${path}.patch`);
	optionalStringValue(file.previous_filename, `${path}.previous_filename`);
	return value as unknown as GitHubPullRequestFile;
}

function validatePullRequestReview(value: unknown, path: string): GitHubPullRequestReview {
	const review = recordValue(value, path);
	integerValue(review.id, `${path}.id`, 1);
	validateUser(review.user, `${path}.user`);
	nullableStringValue(review.body, `${path}.body`);
	stringValue(review.state, `${path}.state`, true);
	nullableStringValue(review.commit_id, `${path}.commit_id`);
	nullableStringValue(review.submitted_at, `${path}.submitted_at`);
	optionalStringValue(review.html_url, `${path}.html_url`);
	return value as unknown as GitHubPullRequestReview;
}

function validateIssueComment(value: unknown, path: string): GitHubIssueComment {
	const comment = recordValue(value, path);
	integerValue(comment.id, `${path}.id`, 1);
	validateUser(comment.user, `${path}.user`);
	nullableStringValue(comment.body, `${path}.body`);
	stringValue(comment.created_at, `${path}.created_at`, true);
	stringValue(comment.updated_at, `${path}.updated_at`, true);
	optionalStringValue(comment.html_url, `${path}.html_url`);
	return value as unknown as GitHubIssueComment;
}

function validateCheckRun(value: unknown, path: string): GitHubCheckRun {
	const checkRun = recordValue(value, path);
	integerValue(checkRun.id, `${path}.id`, 1);
	stringValue(checkRun.name, `${path}.name`, true);
	stringValue(checkRun.status, `${path}.status`, true);
	nullableStringValue(checkRun.conclusion, `${path}.conclusion`);
	optionalNullableStringValue(checkRun.started_at, `${path}.started_at`);
	optionalNullableStringValue(checkRun.completed_at, `${path}.completed_at`);
	optionalNullableStringValue(checkRun.details_url, `${path}.details_url`);
	return value as unknown as GitHubCheckRun;
}

function validateCheckRunsResponse(value: unknown, path: string): CheckRunsResponse {
	const response = recordValue(value, path);
	integerValue(response.total_count, `${path}.total_count`);
	for (const [index, checkRun] of arrayValue(response.check_runs, `${path}.check_runs`).entries()) {
		validateCheckRun(checkRun, `${path}.check_runs[${index}]`);
	}
	return value as unknown as CheckRunsResponse;
}

function validateCommitStatus(value: unknown, path: string): GitHubCommitStatus {
	const status = recordValue(value, path);
	integerValue(status.id, `${path}.id`, 1);
	stringValue(status.context, `${path}.context`, true);
	stringValue(status.state, `${path}.state`, true);
	nullableStringValue(status.description, `${path}.description`);
	nullableStringValue(status.target_url, `${path}.target_url`);
	optionalStringValue(status.created_at, `${path}.created_at`);
	optionalStringValue(status.updated_at, `${path}.updated_at`);
	return value as unknown as GitHubCommitStatus;
}

function validateCombinedStatusResponse(value: unknown, path: string): CombinedStatusResponse {
	const response = recordValue(value, path);
	integerValue(response.total_count, `${path}.total_count`);
	for (const [index, status] of arrayValue(response.statuses, `${path}.statuses`).entries()) {
		validateCommitStatus(status, `${path}.statuses[${index}]`);
	}
	return value as unknown as CombinedStatusResponse;
}

function validateRequiredCheck(value: unknown, path: string): GitHubRequiredStatusCheck {
	const check = recordValue(value, path);
	stringValue(check.context, `${path}.context`, true);
	if (check.app_id !== null) {
		integerValue(check.app_id, `${path}.app_id`, 1);
	}
	return value as unknown as GitHubRequiredStatusCheck;
}

function validateRequiredChecksResponse(value: unknown, path: string): RequiredChecksResponse {
	const response = recordValue(value, path);
	for (const [index, context] of arrayValue(response.contexts, `${path}.contexts`).entries()) {
		stringValue(context, `${path}.contexts[${index}]`, true);
	}
	for (const [index, check] of arrayValue(response.checks, `${path}.checks`).entries()) {
		validateRequiredCheck(check, `${path}.checks[${index}]`);
	}
	return value as unknown as RequiredChecksResponse;
}

function retryAfterMilliseconds(response: Response, attempt: number, fallback: number): number {
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter !== null) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
		}
		const date = Date.parse(retryAfter);
		if (!Number.isNaN(date)) {
			return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS);
		}
	}
	return Math.min(fallback * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function isSecondaryRateLimit(response: Response, body: string): boolean {
	if (response.status === 429) {
		return true;
	}
	if (response.status !== 403) {
		return false;
	}
	const normalized = body.toLowerCase();
	return (
		response.headers.has("retry-after") ||
		normalized.includes("secondary rate limit") ||
		normalized.includes("abuse detection")
	);
}

export class GitHubProvider {
	readonly repo: string;
	readonly apiBase: string;

	private readonly owner: string;
	private readonly name: string;
	private readonly token: string | undefined;
	private readonly fetch: GitHubFetch;
	private readonly wait: (milliseconds: number) => Promise<void>;
	private readonly maxRetries: number;
	private readonly retryDelayMs: number;

	constructor(options: GitHubProviderOptions) {
		const match = options.repo.trim().match(/^([^/]+)\/([^/]+)$/);
		if (!match?.[1] || !match[2]) {
			throw new InfraError(`invalid GitHub repository identity: ${options.repo}`, {
				kind: "configuration",
				operation: "configure GitHub provider",
			});
		}

		this.owner = match[1];
		this.name = match[2];
		this.repo = `${this.owner}/${this.name}`;
		this.apiBase = (options.apiBase ?? process.env.GITHUB_API_URL ?? DEFAULT_API_BASE).replace(/\/+$/, "");
		this.token = options.token ?? process.env.GITHUB_TOKEN;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.wait = options.sleep ?? sleep;
		this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
		this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);

		try {
			new URL(this.apiBase);
		} catch (error) {
			throw new InfraError(`invalid GitHub API base URL: ${this.apiBase}`, {
				kind: "configuration",
				operation: "configure GitHub provider",
				cause: error,
			});
		}
	}

	async getPullRequest(pullNumber: number): Promise<GitHubPullRequest> {
		return this.requestObject<GitHubPullRequest>(
			`/pulls/${this.integer(pullNumber, "pull request")}`,
			{
				operation: `read pull request #${pullNumber}`,
			},
			validatePullRequest,
		);
	}

	async getIssue(issueNumber: number): Promise<GitHubIssue> {
		return this.requestObject<GitHubIssue>(
			`/issues/${this.integer(issueNumber, "issue")}`,
			{
				operation: `read issue #${issueNumber}`,
			},
			validateIssue,
		);
	}

	async getPullRequestFiles(pullNumber: number): Promise<GitHubPullRequestFile[]> {
		return this.paginateArray<GitHubPullRequestFile>(
			`/pulls/${this.integer(pullNumber, "pull request")}/files`,
			`read files for pull request #${pullNumber}`,
			validatePullRequestFile,
			MAX_PULL_REQUEST_FILES,
		);
	}

	async getPullRequestReviews(pullNumber: number): Promise<GitHubPullRequestReview[]> {
		return this.paginateArray<GitHubPullRequestReview>(
			`/pulls/${this.integer(pullNumber, "pull request")}/reviews`,
			`read reviews for pull request #${pullNumber}`,
			validatePullRequestReview,
		);
	}

	async getIssueComments(issueNumber: number): Promise<GitHubIssueComment[]> {
		return this.paginateArray<GitHubIssueComment>(
			`/issues/${this.integer(issueNumber, "issue")}/comments`,
			`read comments for issue #${issueNumber}`,
			validateIssueComment,
		);
	}

	async getCheckRuns(ref: string): Promise<GitHubCheckRun[]> {
		const validatedRef = this.component(ref, "commit ref");
		return this.paginateCounted<GitHubCheckRun, CheckRunsResponse>(
			`/commits/${encodeURIComponent(validatedRef)}/check-runs`,
			`read check runs for ${validatedRef}`,
			validateCheckRunsResponse,
			(response) => response.total_count,
			(response) => response.check_runs,
		);
	}

	async getCommitStatuses(ref: string): Promise<GitHubCommitStatus[]> {
		const validatedRef = this.component(ref, "commit ref");
		return this.paginateCounted<GitHubCommitStatus, CombinedStatusResponse>(
			`/commits/${encodeURIComponent(validatedRef)}/status`,
			`read commit statuses for ${validatedRef}`,
			validateCombinedStatusResponse,
			(response) => response.total_count,
			(response) => response.statuses,
		);
	}

	async getPullRequestLabels(pullNumber: number): Promise<GitHubLabel[]> {
		return this.paginateArray<GitHubLabel>(
			`/issues/${this.integer(pullNumber, "pull request")}/labels`,
			`read labels for pull request #${pullNumber}`,
			validateLabel,
		);
	}

	async addIssueLabels(issueNumber: number, labels: string[]): Promise<GitHubLabel[]> {
		return this.requestArray<GitHubLabel>(
			`/issues/${this.integer(issueNumber, "issue")}/labels`,
			{
				method: "POST",
				body: { labels },
				operation: `add labels to issue #${issueNumber}`,
			},
			validateLabel,
		);
	}

	/** Idempotent: a label that is already absent (HTTP 404) counts as success, not a fault. */
	async removeIssueLabel(issueNumber: number, label: string): Promise<void> {
		const encodedLabel = encodeURIComponent(this.component(label, "label name"));
		await this.requestVoid(`/issues/${this.integer(issueNumber, "issue")}/labels/${encodedLabel}`, {
			method: "DELETE",
			operation: `remove label ${JSON.stringify(label)} from issue #${issueNumber}`,
			treatNotFoundAsSuccess: true,
		});
	}

	async getBranchProtectionRequiredChecks(branch: string): Promise<RequiredChecksResult> {
		const validatedBranch = this.component(branch, "branch");
		const operation = `read required checks for branch ${validatedBranch}`;
		try {
			const response = await this.requestObject<RequiredChecksResponse>(
				`/branches/${encodeURIComponent(validatedBranch)}/protection/required_status_checks`,
				{ operation },
				validateRequiredChecksResponse,
			);
			return { available: true, contexts: response.contexts, checks: response.checks };
		} catch (error) {
			if (error instanceof InfraError && (error.status === 403 || error.status === 404)) {
				return {
					available: false,
					reason: error.status === 403 ? "forbidden" : "not-found",
					status: error.status,
					message: error.reason,
				};
			}
			throw error;
		}
	}

	async createIssueComment(issueNumber: number, body: string): Promise<GitHubIssueComment> {
		return this.requestObject<GitHubIssueComment>(
			`/issues/${this.integer(issueNumber, "issue")}/comments`,
			{
				method: "POST",
				body: { body },
				operation: `create comment on issue #${issueNumber}`,
			},
			validateIssueComment,
		);
	}

	async updateIssueComment(commentId: number, body: string): Promise<GitHubIssueComment> {
		return this.requestObject<GitHubIssueComment>(
			`/issues/comments/${this.integer(commentId, "comment")}`,
			{
				method: "PATCH",
				body: { body },
				operation: `update issue comment ${commentId}`,
			},
			validateIssueComment,
		);
	}

	private integer(value: number, name: string): number {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new InfraError(`invalid ${name} number: ${value}`, {
				kind: "configuration",
				operation: `validate ${name} number`,
			});
		}
		return value;
	}

	private component(value: string, name: string): string {
		if (value.length === 0) {
			throw new InfraError(`invalid empty GitHub ${name}`, {
				kind: "configuration",
				operation: `validate GitHub ${name}`,
			});
		}
		return value;
	}

	private repoPath(path: string): string {
		return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}${path}`;
	}

	private async paginateArray<T>(
		path: string,
		operation: string,
		validateItem: (value: unknown, path: string) => T,
		limit = Number.POSITIVE_INFINITY,
	): Promise<T[]> {
		const values: T[] = [];
		const maximumPages = Number.isFinite(limit) ? Math.ceil(limit / DEFAULT_PAGE_SIZE) : MAX_PAGINATION_PAGES;
		for (let page = 1; page <= maximumPages && values.length < limit; page += 1) {
			const separator = path.includes("?") ? "&" : "?";
			const pageValues = await this.requestArray<T>(
				`${path}${separator}per_page=${DEFAULT_PAGE_SIZE}&page=${page}`,
				{ operation },
				validateItem,
			);
			if (pageValues.length > DEFAULT_PAGE_SIZE) {
				throw this.payloadError(operation, `page ${page} contained more than ${DEFAULT_PAGE_SIZE} items`);
			}
			const remaining = limit - values.length;
			values.push(...pageValues.slice(0, remaining));
			if (pageValues.length < DEFAULT_PAGE_SIZE || values.length >= limit) {
				return values;
			}
		}
		throw this.payloadError(operation, `pagination exceeded ${maximumPages} pages without terminating`);
	}

	private async paginateCounted<T, TResponse>(
		path: string,
		operation: string,
		validateResponse: (value: unknown, path: string) => TResponse,
		getTotal: (response: TResponse) => number,
		getItems: (response: TResponse) => T[],
	): Promise<T[]> {
		const values: T[] = [];
		let expectedTotal: number | undefined;
		for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
			const response = await this.requestObject<TResponse>(
				`${path}?per_page=${DEFAULT_PAGE_SIZE}&page=${page}`,
				{ operation },
				validateResponse,
			);
			const total = getTotal(response);
			const pageValues = getItems(response);
			if (total > MAX_PAGINATED_ITEMS) {
				throw this.payloadError(operation, `total_count exceeds the ${MAX_PAGINATED_ITEMS} item safety limit`);
			}
			if (expectedTotal === undefined) {
				expectedTotal = total;
			} else if (total !== expectedTotal) {
				throw this.payloadError(operation, `total_count changed from ${expectedTotal} to ${total} during pagination`);
			}
			if (pageValues.length > DEFAULT_PAGE_SIZE) {
				throw this.payloadError(operation, `page ${page} contained more than ${DEFAULT_PAGE_SIZE} items`);
			}
			if (values.length + pageValues.length > total) {
				throw this.payloadError(operation, `received more items than total_count ${total}`);
			}
			values.push(...pageValues);
			if (values.length === total) {
				return values;
			}
			if (pageValues.length < DEFAULT_PAGE_SIZE) {
				throw this.payloadError(operation, `pagination ended at ${values.length} of total_count ${total}`);
			}
		}
		throw this.payloadError(operation, `pagination exceeded ${MAX_PAGINATION_PAGES} pages without terminating`);
	}

	private async requestArray<T>(
		path: string,
		options: RequestOptions,
		validateItem: (value: unknown, path: string) => T,
	): Promise<T[]> {
		const value = await this.requestJson(path, options);
		return this.validatePayload(options.operation, value, (payload, payloadPath) =>
			arrayValue(payload, payloadPath).map((item, index) => validateItem(item, `${payloadPath}[${index}]`)),
		);
	}

	private async requestObject<T>(
		path: string,
		options: RequestOptions,
		validate: (value: unknown, path: string) => T,
	): Promise<T> {
		const value = await this.requestJson(path, options);
		return this.validatePayload(options.operation, value, validate);
	}

	private validatePayload<T>(operation: string, value: unknown, validate: (value: unknown, path: string) => T): T {
		try {
			return validate(value, "$");
		} catch (error) {
			if (error instanceof InfraError) {
				throw error;
			}
			const detail =
				error instanceof PayloadValidationError ? error.message : `validation failed: ${describeError(error)}`;
			throw this.payloadError(operation, detail, error);
		}
	}

	private payloadError(operation: string, detail: string, cause?: unknown): InfraError {
		return new InfraError(`${operation}: invalid GitHub response payload (${detail})`, {
			kind: "payload",
			operation,
			cause,
		});
	}

	private async requestJson(path: string, options: RequestOptions): Promise<unknown> {
		const method = options.method ?? "GET";
		const url = `${this.apiBase}${this.repoPath(path)}`;
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (this.token) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		let requestBody: string | undefined;
		if (options.body !== undefined) {
			headers["Content-Type"] = "application/json";
			try {
				requestBody = JSON.stringify(options.body);
			} catch (error) {
				throw new InfraError(`${options.operation}: failed to encode request JSON: ${describeError(error)}`, {
					kind: "json",
					operation: options.operation,
					method,
					url,
					cause: error,
				});
			}
		}

		for (let attempt = 0; ; attempt += 1) {
			let response: Response;
			try {
				response = await this.fetch(url, { method, headers, body: requestBody });
			} catch (error) {
				throw new InfraError(`${options.operation}: GitHub request failed: ${describeError(error)}`, {
					kind: "network",
					operation: options.operation,
					method,
					url,
					cause: error,
				});
			}

			let responseBody: string;
			try {
				responseBody = await response.text();
			} catch (error) {
				throw new InfraError(`${options.operation}: failed to read GitHub response: ${describeError(error)}`, {
					kind: "network",
					operation: options.operation,
					method,
					url,
					status: response.status,
					cause: error,
				});
			}

			if (!response.ok) {
				if (attempt < this.maxRetries && isSecondaryRateLimit(response, responseBody)) {
					try {
						await this.wait(retryAfterMilliseconds(response, attempt, this.retryDelayMs));
					} catch (error) {
						throw new InfraError(`${options.operation}: rate-limit backoff failed: ${describeError(error)}`, {
							kind: "network",
							operation: options.operation,
							method,
							url,
							status: response.status,
							cause: error,
						});
					}
					continue;
				}
				const excerpt = responseExcerpt(responseBody);
				const suffix = excerpt.length > 0 ? `: ${excerpt}` : "";
				throw new InfraError(`${options.operation}: GitHub returned HTTP ${response.status}${suffix}`, {
					kind: "http",
					operation: options.operation,
					method,
					url,
					status: response.status,
					responseBody: excerpt,
				});
			}

			if (responseBody.length === 0) {
				throw new InfraError(`${options.operation}: GitHub returned an empty JSON response`, {
					kind: "json",
					operation: options.operation,
					method,
					url,
					status: response.status,
				});
			}

			try {
				return JSON.parse(responseBody) as unknown;
			} catch (error) {
				throw new InfraError(`${options.operation}: failed to parse GitHub response JSON: ${describeError(error)}`, {
					kind: "json",
					operation: options.operation,
					method,
					url,
					status: response.status,
					responseBody: responseExcerpt(responseBody),
					cause: error,
				});
			}
		}
	}

	/**
	 * Like requestJson, but for endpoints that return no body (e.g. DELETE ->
	 * 204). Never parses a response body; `treatNotFoundAsSuccess` lets
	 * idempotent deletes (label already gone) succeed silently on 404.
	 */
	private async requestVoid(
		path: string,
		options: RequestOptions & { treatNotFoundAsSuccess?: boolean },
	): Promise<void> {
		const method = options.method ?? "GET";
		const url = `${this.apiBase}${this.repoPath(path)}`;
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (this.token) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		for (let attempt = 0; ; attempt += 1) {
			let response: Response;
			try {
				response = await this.fetch(url, { method, headers });
			} catch (error) {
				throw new InfraError(`${options.operation}: GitHub request failed: ${describeError(error)}`, {
					kind: "network",
					operation: options.operation,
					method,
					url,
					cause: error,
				});
			}

			if (response.ok) {
				return;
			}
			if (options.treatNotFoundAsSuccess && response.status === 404) {
				return;
			}

			let responseBody: string;
			try {
				responseBody = await response.text();
			} catch (error) {
				throw new InfraError(`${options.operation}: failed to read GitHub response: ${describeError(error)}`, {
					kind: "network",
					operation: options.operation,
					method,
					url,
					status: response.status,
					cause: error,
				});
			}

			if (attempt < this.maxRetries && isSecondaryRateLimit(response, responseBody)) {
				try {
					await this.wait(retryAfterMilliseconds(response, attempt, this.retryDelayMs));
				} catch (error) {
					throw new InfraError(`${options.operation}: rate-limit backoff failed: ${describeError(error)}`, {
						kind: "network",
						operation: options.operation,
						method,
						url,
						status: response.status,
						cause: error,
					});
				}
				continue;
			}

			const excerpt = responseExcerpt(responseBody);
			const suffix = excerpt.length > 0 ? `: ${excerpt}` : "";
			throw new InfraError(`${options.operation}: GitHub returned HTTP ${response.status}${suffix}`, {
				kind: "http",
				operation: options.operation,
				method,
				url,
				status: response.status,
				responseBody: excerpt,
			});
		}
	}
}
