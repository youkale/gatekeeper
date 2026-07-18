import type { ContractHit, FileMatch, ForbiddenEdit, Verdict } from "../engine/types.js";

/** Render a Verdict (or a degraded/fail-open placeholder) as a single-line JSON string. */
export function renderVerdictJson(verdict: Verdict): string {
	return JSON.stringify(verdict);
}

export interface DegradedReport {
	degraded: true;
	reason: string;
}

export function renderDegradedJson(reason: string): string {
	return JSON.stringify({ degraded: true, reason } satisfies DegradedReport);
}

function decisionLabel(decision: Verdict["decision"]): string {
	switch (decision) {
		case "block":
			return "BLOCK";
		case "warn":
			return "WARN";
		case "pass":
			return "PASS";
	}
}

/** Human-readable one-block summary of a verdict: decision, touched contracts, forbidden edits. */
export function renderSummary(verdict: Verdict): string[] {
	const lines: string[] = [];
	lines.push(`GATEKEEPER ${decisionLabel(verdict.decision)} (repo=${verdict.repo})`);

	if (verdict.touched.length === 0) {
		lines.push("  no contracts touched");
	} else {
		lines.push(`  touched ${verdict.touched.length} contract(s):`);
		for (const hit of verdict.touched) {
			const requirement = hit.requires ? ` requires m=${hit.requires.m} lanes=[${hit.requires.lanes.join(", ")}]` : "";
			lines.push(`    - ${hit.contract} [level=${hit.level}] enforcement=${hit.effectiveEnforcement}${requirement}`);
		}
	}

	if (verdict.forbiddenEdits.length > 0) {
		lines.push(`  forbidden edits (${verdict.forbiddenEdits.length}):`);
		for (const edit of verdict.forbiddenEdits) {
			const allowed = edit.allowActors.length > 0 ? edit.allowActors.join(", ") : "(none configured)";
			lines.push(`    - ${edit.contract}: actor=${edit.actor ?? "(unknown)"} allow_actors=[${allowed}]`);
		}
	}

	if (verdict.effectivePolicy.enforcementOverride) {
		lines.push(
			`  adoption.enforcement_override=${verdict.effectivePolicy.enforcementOverride} (downgrades block to warn)`,
		);
	}

	return lines;
}

function policyClause(hit: ContractHit): string {
	const requirement = hit.requires ? ` requires m=${hit.requires.m} lanes=[${hit.requires.lanes.join(", ")}]` : "";
	return `enforcement=${hit.effectiveEnforcement}${requirement}`;
}

function fileProvenanceLine(fileMatch: FileMatch, hit: ContractHit): string {
	return (
		`${fileMatch.path} (${fileMatch.status}) -> glob "${fileMatch.matchedGlob}" (matched ${fileMatch.matchedPath}) ` +
		`-> contract ${hit.contract} [level=${hit.level}] -> policy ${policyClause(hit)}`
	);
}

function forbiddenProvenanceLine(fileMatch: FileMatch, edit: ForbiddenEdit): string {
	const allowed = edit.allowActors.length > 0 ? edit.allowActors.join(", ") : "(none configured)";
	return (
		`${fileMatch.path} (${fileMatch.status}) -> glob "${fileMatch.matchedGlob}" (matched ${fileMatch.matchedPath}) ` +
		`-> contract ${edit.contract} -> FORBIDDEN actor=${edit.actor ?? "(unknown)"} allow_actors=[${allowed}]`
	);
}

/**
 * Line-by-line provenance trace: file -> matched glob -> contract -> policy clause,
 * for every touched file, plus a FORBIDDEN trace for mirror-frozen violations.
 */
export function renderExplain(verdict: Verdict): string[] {
	const lines: string[] = [];

	for (const hit of verdict.touched) {
		for (const binding of hit.bindings) {
			for (const fileMatch of binding.files) {
				lines.push(fileProvenanceLine(fileMatch, hit));
			}
		}
	}

	for (const edit of verdict.forbiddenEdits) {
		for (const fileMatch of edit.files) {
			lines.push(forbiddenProvenanceLine(fileMatch, edit));
		}
	}

	if (lines.length === 0) {
		lines.push("no matched files to explain");
	}

	return lines;
}
