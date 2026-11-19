/**
 * Fallback for a request whose images the model service refuses. A request that carries images and
 * is refused with 413, or with a 400 that is not a context overflow, is sent once more without
 * them. When that one is accepted, the images were the cause: their handles are remembered, every
 * later request through this client leaves them out, and each record that lost one gets the
 * `imageLeftOut` line after its text. The handles live in memory only, so after a restart the first
 * request carrying one of them is refused once more.
 *
 * A 413 is retried without images even though `isContextOverflow` counts it: attachment bytes reach a
 * service's body size limit long before they move the token count. A 413 that survives the retry
 * reaches Core as a context overflow.
 */
import { createHash } from 'node:crypto';
import { BaseProvider } from '../base.ts';
import { GenerationError, type GenerateOptions, type Generation } from '../../core/generation.ts';
import { inputItem, type ContextRecord, type Item } from '../../protocol/open-responses/context.ts';
import type { Request, Schemas } from '../../protocol/open-responses/index.ts';
import type { Logger } from '../../core/types.ts';
import { imageBlobs, type CompatMediaOptions } from './history.ts';

/** Statuses of a request the service will not take as written. */
const REFUSED: ReadonlySet<number> = new Set([400, 413]);

export interface ImageFallbackOptions {
  media: CompatMediaOptions;
  /** The module's `contextOverflow`. A refusal it matches is not retried, except a 413. */
  contextOverflow(error: GenerationError): boolean;
  /** The records whose images the client attaches to a request; every record when absent. */
  attached?(context: readonly ContextRecord[]): readonly ContextRecord[];
  log: Logger;
}

/** Follows the `[blob …]` line of an image a request goes out without. */
export const imageLeftOut = (handle: string): string =>
  `[${handle} left out: the model service rejected the request that carried this image]`;

export class ImageFallback extends BaseProvider {
  /** Images whose request was accepted only without them. */
  private readonly refused = new Set<string>();

  constructor(private readonly inner: BaseProvider, private readonly options: ImageFallbackOptions) {
    super();
  }

  async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const context = options.context && withoutImages(options.context, this.refused);
    const outbound = context && context !== options.context ? { ...request, input: context.map(inputItem) } : request;
    try {
      return await this.inner.respond(outbound, context ? { ...options, context } : options);
    } catch (error) {
      if (!context || options.diagnostic || options.signal?.aborted || !(error instanceof GenerationError) || !this.retried(error)) throw error;
      const sent = this.sentImages(context);
      if (!sent.size) throw error;
      let generation: Generation;
      try {
        const retryContext = withoutImages(context, sent);
        generation = await this.inner.respond({ ...request, input: retryContext.map(inputItem) }, { ...options, context: retryContext });
      } catch (retry) {
        if (!(retry instanceof GenerationError)) throw retry;
        throw new GenerationError(retry.message, [...error.attempts, ...retry.attempts], retry.partial, retry.origin, retry.status, retry.body, { cause: retry.cause });
      }
      for (const handle of sent) this.refused.add(handle);
      this.options.log.warn('Model service rejected a request with images; sent again without them', { status: error.status, images: [...sent] });
      return { ...generation, attempts: [...error.attempts, ...generation.attempts] };
    }
  }

  private retried(error: GenerationError): boolean {
    return REFUSED.has(error.status) && (error.status === 413 || !this.options.contextOverflow(error));
  }

  /** The images the client attaches to a request built from `context`. */
  private sentImages(context: readonly ContextRecord[]): Set<string> {
    const { media, attached } = this.options;
    const promoteBlobs = media.enabled();
    return new Set((attached?.(context) ?? context).flatMap((entry) => [
      ...inlineImages(entry.item).map(inlineImageHandle),
      ...(promoteBlobs ? imageBlobs(entry.context.blobs).filter((ref) => media.read(ref.handle)).map((ref) => ref.handle) : []),
    ]));
  }
}

type InlineImage = Schemas['InputImageContentParamAutoParam'];

/** Standard image parts are already in the request, independently of automatic blob promotion. */
function inlineImages(item: Item): InlineImage[] {
  const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined;
  return Array.isArray(parts) ? parts.filter((part): part is InlineImage => part.type === 'input_image') : [];
}

/** Stable opaque identities keep URLs and image bytes out of omission lines and logs. */
function inlineImageHandle(image: InlineImage): string {
  return `inline-image:${createHash('sha256').update(JSON.stringify([image.image_url ?? null, image.detail ?? null])).digest('hex')}`;
}

function withoutInlineImages(item: Item, handles: ReadonlySet<string>): Item {
  const keep = (part: { type: string }) => part.type !== 'input_image' || !handles.has(inlineImageHandle(part as InlineImage));
  if (item.type === 'message' && Array.isArray(item.content)) return { ...item, content: item.content.filter(keep) } as Item;
  if (item.type === 'function_call_output' && Array.isArray(item.output)) return { ...item, output: item.output.filter(keep) };
  return item;
}

/** The context without the images in `handles`; each record that lost one gets an `imageLeftOut` line per image. */
export function withoutImages(context: readonly ContextRecord[], handles: ReadonlySet<string>): readonly ContextRecord[] {
  if (!handles.size) return context;
  let changed = false;
  const filtered = context.map((entry) => {
    const blobs = entry.context.blobs ?? [];
    const out = imageBlobs(blobs).filter((ref) => handles.has(ref.handle));
    const inline = inlineImages(entry.item).map(inlineImageHandle).filter((handle) => handles.has(handle));
    if (!out.length && !inline.length) return entry;
    changed = true;
    const omitted = [...new Set([...out.map((ref) => ref.handle), ...inline])];
    return {
      ...entry,
      item: withLine(withoutInlineImages(entry.item, handles), omitted.map(imageLeftOut).join('\n')),
      context: out.length ? { ...entry.context, blobs: blobs.filter((ref) => !out.includes(ref)) } : entry.context,
    };
  });
  return changed ? filtered : context;
}

/**
 * The item with `line` on its own line after its text; content parts other than text stay in place.
 * An appended part starts with a newline because Chat joins text parts without a separator.
 */
function withLine(item: Item, line: string): Item {
  if (item.type === 'message')
    return { ...item, content: typeof item.content === 'string' ? `${item.content}\n${line}` : [...item.content, { type: 'input_text', text: `\n${line}` }] } as Item;
  if (item.type === 'function_call_output')
    return { ...item, output: typeof item.output === 'string' ? `${item.output}\n${line}` : [...item.output, { type: 'input_text', text: `\n${line}` }] } as Item;
  return item;
}
