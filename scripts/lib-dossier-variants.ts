/**
 * lib-dossier-variants.ts — the dossier quality experiments, now mostly a
 * HISTORY. Everything that won its measurement graduated into
 * src/lib/character-dossier.ts on 2026-08-13:
 *
 *   · voice + company counted lines  → composeExtractiveParts (on-tier core
 *     coverage 4% → 14%, zero fabrication, same sub-second cost)
 *   · fusion request / gate / retry  → buildFusionRequest, groundFusion,
 *     buildFusionRetryRequest (max tier only; the 1.7B failed the gate
 *     11 of 12 times and the ON tier never attempts it)
 *   · reason-first personality       → fieldSchema/fieldSystem (replaces the
 *     1024-token think pass; ~30s → ~7s for equal-or-better answers)
 *   · deep caps                      → FIELD_MAX 220/300/260, ask word caps
 *     30/40/35, conduct-first personality instruction
 *   · wider max evidence             → MAX_PACK_OPTS (span cap 20, quota 4)
 *
 * Tried and REVERTED, twice: the deterministic ACTION line ("the one who
 * filed, agreed, closed") — the verb-tally lesson; distinctive verbs stay
 * pack facts for the model to phrase.
 *
 * What remains here are thin aliases so the bench runner's variant flags
 * keep working against the shipped implementations.
 */
import {
  buildDossierPack,
  buildFieldRequest,
  composeExtractiveParts,
  MAX_PACK_OPTS,
  type CharacterDossierEvidence,
  type DossierFieldKey,
  type DossierPack,
} from "../src/lib/character-dossier";

export {
  buildFusionRequest,
  buildFusionRetryRequest,
  groundFusion,
  type FusionInput,
  type FusionRequest,
  type FusionVerdict,
} from "../src/lib/character-dossier";

/** The skeleton variant IS the shipped composition now. */
export function composeSkeleton(
  ev: CharacterDossierEvidence,
  otherCastNames: readonly string[] = [],
): string {
  const out = composeExtractiveParts(ev, otherCastNames).join(" ");
  return out.split(/\s+/).filter(Boolean).length >= 5 ? out : "";
}

/** The deep pack IS the shipped max pack now. */
export function buildDeepPack(ev: CharacterDossierEvidence): DossierPack {
  return buildDossierPack(ev, MAX_PACK_OPTS);
}

/** Deep requests ARE the shipped requests now (reason-first personality and
 *  the raised caps live in the module's own builders). */
export function buildDeepFieldRequest(
  pack: DossierPack,
  field: DossierFieldKey,
): ReturnType<typeof buildFieldRequest> {
  return buildFieldRequest(pack, field, "character");
}
