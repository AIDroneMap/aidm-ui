import { errorResponse } from "../../shared/api-error.ts";
import { isLoopbackAddress, type ClientInfo } from "../auth/hook.ts";
import type { Sessions } from "../auth/sessions.ts";

/** More windows than this following the server at once is a sign of a leak, not of an operator. */
export const MAX_EVENT_STREAMS = 32;
const KEEP_ALIVE_MS = 15_000;

interface OpenStream {
  loopback: boolean;
  end(): void;
}

/**
 * Every server-sent event stream goes through here: it counts them, keeps
 * them alive, and ends those of other computers when their sessions end.
 */
export class EventStreams {
  private readonly open = new Set<OpenStream>();

  constructor(sessions: Sessions) {
    sessions.onClear(() => this.endOtherComputers());
  }

  /**
   * The response for a new stream. `attach` gets the function that sends text
   * and returns the function that detaches from whatever feeds the stream.
   * A refusal when too many streams are open.
   */
  respond(client: ClientInfo, attach: (send: (text: string) => void) => () => void): Response {
    if (this.open.size >= MAX_EVENT_STREAMS) return errorResponse(503, "api.too_many_streams");

    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let detach = () => {};
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const entry: OpenStream = {
      loopback: isLoopbackAddress(client.address),
      end: () => {
        if (!this.open.delete(entry)) return;
        clearInterval(keepAlive);
        detach();
        try {
          controller?.close();
        } catch {
          // Already closed by the client.
        }
      },
    };
    const send = (text: string) => {
      try {
        controller?.enqueue(encoder.encode(text));
      } catch {
        // The client is gone; cancel() cleans up.
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
        this.open.add(entry);
        try {
          detach = attach(send);
        } catch (error) {
          entry.end();
          throw error;
        }
        keepAlive = setInterval(() => send(": keep-alive\n\n"), KEEP_ALIVE_MS);
      },
      cancel: () => entry.end(),
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  }

  private endOtherComputers(): void {
    for (const entry of [...this.open]) {
      if (!entry.loopback) entry.end();
    }
  }
}
