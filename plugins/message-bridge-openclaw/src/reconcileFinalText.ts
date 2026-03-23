export interface ReconcileFinalTextResult {
  appendDelta: string;
  finalText: string;
  finalReconciled: boolean;
}

export function reconcileFinalText(accumulated: string, incomingFinal: string | null | undefined): ReconcileFinalTextResult {
  const baseText = accumulated;
  const candidate = typeof incomingFinal === "string" ? incomingFinal : "";

  if (candidate.length === 0) {
    return {
      appendDelta: "",
      finalText: baseText,
      finalReconciled: false,
    };
  }

  if (baseText.length === 0) {
    return {
      appendDelta: candidate,
      finalText: candidate,
      finalReconciled: false,
    };
  }

  if (candidate.startsWith(baseText)) {
    return {
      appendDelta: candidate.slice(baseText.length),
      finalText: candidate,
      finalReconciled: false,
    };
  }

  return {
    appendDelta: "",
    finalText: candidate,
    finalReconciled: true,
  };
}
