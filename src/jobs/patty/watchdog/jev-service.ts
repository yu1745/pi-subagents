// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const JEV_SERVICE_REQUEST_EVENT = "typesafe-jev:get-service:v1";

export type JevJson = null | boolean | number | string | JevJson[] | { [key: string]: JevJson };

export interface JevQuestion {
    type: "noul" | "choice" | "score";
    instructions: JevJson;
    criteria?: Record<string, JevJson> | JevJson[];
}

export interface JevAnswer {
    type: "noul" | "choice" | "score";
    noul?: number;
    choice?: string;
    probabilities?: Record<string, number>;
    confidence?: number;
    score?: number;
}

export interface JevServiceV1 {
    version: 1;
    evaluate(
        request: { state: JevJson; questions: Record<string, JevQuestion>; model?: string },
        options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<{
        model: string;
        answers: Record<string, JevAnswer>;
        usage: { input_tokens: number; output_tokens: number };
    }>;
}

export function discoverJevService(pi: Pick<ExtensionAPI, "events">): JevServiceV1 | undefined {
    let service: JevServiceV1 | undefined;
    pi.events.emit(JEV_SERVICE_REQUEST_EVENT, {
        accept(candidate: JevServiceV1) {
            if (!service && candidate?.version === 1) service = candidate;
        },
    });
    return service;
}
