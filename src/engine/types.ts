export type ChangeStatus = "A" | "M" | "D" | "R" | "C";

export interface ChangedFile {
	path: string;
	status: ChangeStatus;
	oldPath?: string;
	patch?: string;
}

export type Enforcement = "block" | "warn";

export type BindingRole = "consumer" | "producer" | "mirror-frozen";

export type ExtensionFields = {
	[key: `x-${string}`]: unknown;
};

export interface AuthorityBinding extends ExtensionFields {
	repo: string;
	paths: string[];
	exclude?: string[];
	if_content?: string;
}

export interface ConsumerBinding extends AuthorityBinding {
	verify?: string;
	role: BindingRole;
	allow_actors?: string[];
}

export interface Contract extends ExtensionFields {
	apiVersion: "gatekeeper/v1";
	name: string;
	description?: string;
	level: string;
	authority: AuthorityBinding;
	consumers: ConsumerBinding[];
}

export interface HumanApprovalLane extends ExtensionFields {
	type: "human-approval";
	min: number;
	fresh: boolean;
}

export interface ReviewLanePass extends ExtensionFields {
	state: "APPROVED";
}

export interface ReviewLane extends ExtensionFields {
	type: "review";
	author: string;
	pass: ReviewLanePass;
}

export type Lane = HumanApprovalLane | ReviewLane;

export interface LevelRequirement extends ExtensionFields {
	m?: number;
	lanes?: string[];
}

export interface PolicyLevel extends ExtensionFields {
	enforcement: Enforcement;
	require: LevelRequirement;
}

export interface PolicyAdoption extends ExtensionFields {
	enforcement_override?: "warn";
}

export interface PolicyOverrides extends ExtensionFields {
	label: string;
}

export interface Policy extends ExtensionFields {
	apiVersion: "gatekeeper/v1";
	lanes: Record<string, Lane>;
	levels: Record<string, PolicyLevel>;
	adoption?: PolicyAdoption;
	overrides: PolicyOverrides;
}

export interface RegistryIssue {
	file: string;
	path: string;
	expected: string;
	actual: string;
	hint: string;
}

export interface Registry {
	policy: Policy;
	contracts: Contract[];
	warnings: RegistryIssue[];
}

export interface EngineInput {
	repo: string;
	actor?: string;
	changedFiles: ChangedFile[];
	registry: Registry;
}

export interface Verdict {
	decision: "pass" | "warn" | "block";
	repo: string;
	touched: ContractHit[];
	forbiddenEdits: ForbiddenEdit[];
	effectivePolicy: {
		enforcementOverride: "warn" | null;
	};
}

export interface ContractHit {
	contract: string;
	level: string;
	enforcement: Enforcement;
	effectiveEnforcement: Enforcement;
	requires: { m: number; lanes: string[] } | null;
	bindings: BindingHit[];
	consumers: ConsumerSummary[];
}

export interface BindingHit {
	kind: "authority" | "consumer";
	role: BindingRole | null;
	repo: string;
	verify: string | null;
	files: FileMatch[];
}

export interface FileMatch {
	path: string;
	status: ChangeStatus;
	matchedPath: string;
	matchedGlob: string;
	contentCheck: "not-configured" | "matched" | "no-match" | "skipped-no-patch";
}

export interface ForbiddenEdit {
	contract: string;
	repo: string;
	actor: string | null;
	allowActors: string[];
	files: FileMatch[];
}

export interface ConsumerSummary {
	repo: string;
	role: string;
	verify: string | null;
}
