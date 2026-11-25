/** Pre-restart check on the system prompt file: markers written, or both old gates already gone. */
export function hostPromptKeepsInject(text) {
  const body = String(text || "");
  const identityMarked = body.includes("[de-policy] identity stripped");
  const injectMarked = body.includes("[de-policy] complete prompt keeps waterfall inject")
    || body.includes("[de-policy] complete prompt keeps inject")
    || body.includes("fold-complete inject first");
  if (identityMarked && injectMarked) return true;
  // Empty file, or not this module: cannot be treated as already cleaned.
  if (!body.includes("system-prompt/assemble")) return false;
  const identityLeft = body.includes("You are an AI agent powered by DeepSeek Harness.");
  const dropsInject = body.includes("transformed.sections : [completeSection]");
  return !identityLeft && !dropsInject;
}
