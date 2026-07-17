import { matchBinding } from "./match.js";
import type {
	BindingHit,
	ConsumerBinding,
	ContractHit,
	EngineInput,
	ForbiddenEdit,
	PolicyLevel,
	Verdict,
} from "./types.js";

function requirementFor(level: PolicyLevel): ContractHit["requires"] {
	if (level.require.m === undefined || level.require.lanes === undefined) {
		return null;
	}
	return { m: level.require.m, lanes: [...level.require.lanes] };
}

function consumerBindingHit(consumer: ConsumerBinding, files: BindingHit["files"]): BindingHit {
	return {
		kind: "consumer",
		role: consumer.role,
		repo: consumer.repo,
		verify: consumer.verify ?? null,
		files,
	};
}

export function evaluate(input: EngineInput): Verdict {
	const touched: ContractHit[] = [];
	const forbiddenEdits: ForbiddenEdit[] = [];
	const enforcementOverride = input.registry.policy.adoption?.enforcement_override ?? null;

	for (const contract of input.registry.contracts) {
		const bindings: BindingHit[] = [];

		if (contract.authority.repo === input.repo) {
			const authorityMatch = matchBinding(contract.authority, input.changedFiles);
			if (authorityMatch.files.length > 0) {
				bindings.push({
					kind: "authority",
					role: null,
					repo: contract.authority.repo,
					verify: null,
					files: authorityMatch.evaluatedFiles,
				});
			}
		}

		for (const consumer of contract.consumers) {
			if (consumer.repo !== input.repo) {
				continue;
			}
			const consumerMatch = matchBinding(consumer, input.changedFiles);
			if (consumerMatch.files.length === 0) {
				continue;
			}

			bindings.push(consumerBindingHit(consumer, consumerMatch.evaluatedFiles));
			const allowActors = consumer.allow_actors ?? [];
			if (consumer.role === "mirror-frozen" && (input.actor === undefined || !allowActors.includes(input.actor))) {
				forbiddenEdits.push({
					contract: contract.name,
					repo: input.repo,
					actor: input.actor ?? null,
					allowActors: [...allowActors],
					files: consumerMatch.files,
				});
			}
		}

		if (bindings.length === 0) {
			continue;
		}

		const level = input.registry.policy.levels[contract.level];
		if (!level) {
			throw new Error(`Registry invariant violated: missing level "${contract.level}"`);
		}
		const effectiveEnforcement = enforcementOverride === "warn" ? "warn" : level.enforcement;

		touched.push({
			contract: contract.name,
			level: contract.level,
			enforcement: level.enforcement,
			effectiveEnforcement,
			requires: requirementFor(level),
			bindings,
			consumers: contract.consumers.map((consumer) => ({
				repo: consumer.repo,
				role: consumer.role,
				verify: consumer.verify ?? null,
			})),
		});
	}

	let decision: Verdict["decision"] = "pass";
	if (forbiddenEdits.length > 0) {
		decision = "block";
	} else if (touched.some((hit) => hit.effectiveEnforcement === "block")) {
		decision = "block";
	} else if (touched.length > 0) {
		decision = "warn";
	}

	return {
		decision,
		repo: input.repo,
		touched,
		forbiddenEdits,
		effectivePolicy: { enforcementOverride },
	};
}
