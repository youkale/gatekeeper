export interface GovernanceIssue {
	rule: string;
	message: string;
}

export interface GovernanceCheckResult {
	errors: GovernanceIssue[];
	warnings: GovernanceIssue[];
}

/**
 * Type declaration for the zero-dependency governance checker
 * (scripts/check-governance.mjs), which stays plain JS so `npm run
 * check:governance` never depends on a build step.
 */
export declare function runGovernanceCheck(repoRoot: string): GovernanceCheckResult;
