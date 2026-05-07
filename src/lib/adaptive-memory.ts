import type {
  AdaptiveCharacterMemory,
  AdaptiveContextMemory,
  AdaptiveLearningStore,
  AdaptivePredictionRecord,
  WorldData,
} from "../types";
import { tokenizeAdaptiveText } from "./adaptive-similarity";

function emptyCharacterMemory(name: string): AdaptiveCharacterMemory {
  return {
    name,
    speechCorrections: 0,
    actionCorrections: 0,
    styleTokens: {},
    interactionCounts: {},
  };
}

function ensureCharacter(
  characters: Record<string, AdaptiveCharacterMemory>,
  name: string,
): AdaptiveCharacterMemory {
  if (!characters[name]) characters[name] = emptyCharacterMemory(name);
  return characters[name];
}

function addTokens(target: Record<string, number>, text: string): void {
  for (const token of tokenizeAdaptiveText(text)) {
    target[token] = (target[token] ?? 0) + 1;
  }
}

export function buildAdaptiveContextMemory(
  store: AdaptiveLearningStore,
  worldData?: WorldData,
): AdaptiveContextMemory {
  const characters: Record<string, AdaptiveCharacterMemory> = {};
  for (const character of worldData?.characters ?? []) {
    ensureCharacter(characters, character.name);
  }

  const correctedSpeech = store.predictions
    .filter(
      (prediction): prediction is AdaptivePredictionRecord & { correctedLabel: string } =>
        prediction.task === "speech" && typeof prediction.correctedLabel === "string",
    )
    .sort((a, b) => {
      if (a.chapterId < b.chapterId) return -1;
      if (a.chapterId > b.chapterId) return 1;
      if (a.paragraphIndex !== b.paragraphIndex) return a.paragraphIndex - b.paragraphIndex;
      return a.spanIndex - b.spanIndex;
    });

  for (const prediction of store.predictions) {
    if (typeof prediction.correctedLabel !== "string") continue;
    const memory = ensureCharacter(characters, prediction.correctedLabel);
    if (prediction.task === "speech") {
      memory.speechCorrections += 1;
      addTokens(memory.styleTokens, prediction.spanText);
    } else if (prediction.task === "action") {
      memory.actionCorrections += 1;
      addTokens(memory.styleTokens, prediction.contextBefore + " " + prediction.spanText);
    }
  }

  const transitions: Record<string, Record<string, number>> = {};
  for (let i = 1; i < correctedSpeech.length; i++) {
    const prev = correctedSpeech[i - 1];
    const next = correctedSpeech[i];
    if (prev.chapterId !== next.chapterId) continue;
    const prevLabel = prev.correctedLabel;
    const nextLabel = next.correctedLabel;
    if (prevLabel === nextLabel) continue;
    const prevMemory = ensureCharacter(characters, prevLabel);
    prevMemory.interactionCounts[nextLabel] = (prevMemory.interactionCounts[nextLabel] ?? 0) + 1;
    if (!transitions[prevLabel]) transitions[prevLabel] = {};
    transitions[prevLabel][nextLabel] = (transitions[prevLabel][nextLabel] ?? 0) + 1;
  }

  for (const nexts of Object.values(transitions)) {
    const total = Object.values(nexts).reduce((sum, value) => sum + value, 0) || 1;
    for (const [next, value] of Object.entries(nexts)) {
      nexts[next] = value / total;
    }
  }

  return {
    sampleCount: store.predictions.filter((prediction) => prediction.correctedLabel !== undefined).length,
    characters,
    speakerTransitions: transitions,
  };
}

export function styleOverlapScore(
  memory: AdaptiveContextMemory,
  label: string | null,
  text: string,
): number {
  if (!label) return 0;
  const character = memory.characters[label];
  if (!character) return 0;
  const tokens = tokenizeAdaptiveText(text);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    hits += character.styleTokens[token] ?? 0;
  }
  return Math.min(1, hits / Math.max(1, tokens.length * 2));
}

export function transitionBiasScore(
  memory: AdaptiveContextMemory,
  previousSpeaker: string | null | undefined,
  candidateLabel: string | null,
): number {
  if (!previousSpeaker || !candidateLabel) return 0;
  return memory.speakerTransitions[previousSpeaker]?.[candidateLabel] ?? 0;
}