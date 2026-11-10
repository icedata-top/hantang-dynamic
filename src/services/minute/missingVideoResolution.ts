import type { VideoDeletionNotes } from "../../database/videos";
import { logger } from "../../utils/logger";
import type { FavoriteFallbackMissingAid } from "./batchSampleVideoStats";

export type MissingVideoOutcome =
  /** Bilibili reports the video gone; it is now disabled in the database. */
  | "deleted"
  /** The video exists and was added back to its Watch Later list. */
  | "restored"
  /** The video exists but there is no Watch Later list to put it back in. */
  | "present"
  /** The video exists but adding it back failed; the next cycle retries. */
  | "restore_failed"
  /** The detail lookup itself failed, so nothing was concluded. */
  | "check_failed";

export interface MissingVideoResolutionDependencies {
  /** Resolves `null` when Bilibili answers 404 (deleted). */
  fetchDetail(aid: bigint): Promise<unknown | null>;
  markDeleted(aid: bigint, notes?: VideoDeletionNotes): Promise<unknown>;
  /** Re-adds the video to the account's Watch Later; true once accepted. */
  restoreToWatchLater(aid: bigint, accountId: bigint): Promise<boolean>;
}

/**
 * `fetchVideoFullDetail` throws `VIDEO_UNAVAILABLE:<id>:<code>:<message>` for
 * invisible / under-review / private videos. The detail pipeline already
 * records those as deleted, so this path does the same.
 */
function unavailableNotes(error: unknown): VideoDeletionNotes | null {
  if (
    !(error instanceof Error) ||
    !error.message.startsWith("VIDEO_UNAVAILABLE:")
  ) {
    return null;
  }
  const [, , code, ...message] = error.message.split(":");
  return { api_code: Number(code), api_message: message.join(":") };
}

/**
 * Explain why the favorite endpoint returned nothing for a video:
 *  a) the video is deleted -> mark it deleted so it is never sampled again;
 *  b) otherwise it was dropped from its Watch Later list -> add it back.
 */
export async function resolveMissingVideo(
  item: FavoriteFallbackMissingAid,
  dependencies: MissingVideoResolutionDependencies,
): Promise<MissingVideoOutcome> {
  let detail: unknown | null;
  try {
    detail = await dependencies.fetchDetail(item.aid);
  } catch (error) {
    const notes = unavailableNotes(error);
    if (notes === null) {
      logger.warn(`Could not check missing video av${item.aid}:`, error);
      return "check_failed";
    }
    await dependencies.markDeleted(item.aid, notes);
    logger.info(
      `Video av${item.aid} is unavailable (code ${notes.api_code}); marked deleted`,
    );
    return "deleted";
  }

  if (detail === null) {
    await dependencies.markDeleted(item.aid);
    logger.info(`Video av${item.aid} no longer exists; marked deleted`);
    return "deleted";
  }

  if (item.absentFromToViewAccountId === null) return "present";

  const restored = await dependencies.restoreToWatchLater(
    item.aid,
    item.absentFromToViewAccountId,
  );
  if (!restored) return "restore_failed";
  logger.info(
    `Video av${item.aid} was missing from Watch Later account ${item.absentFromToViewAccountId}; added it back`,
  );
  return "restored";
}
