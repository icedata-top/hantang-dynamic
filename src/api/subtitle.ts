import type { AxiosInstance } from "axios";
import axios from "axios";
import {
  subtitleApiRequestDurationSeconds,
  subtitleApiRequestsTotal,
} from "../metrics/registry.js";
import type { BiliVideoDetailResponse } from "../types/api/video.js";
import type {
  BiliPlayerWbiV2Response,
  BiliSubtitleJson,
  BiliSubtitleTrackInfo,
} from "../types/bilibili/subtitle.js";
import { logger } from "../utils/logger.js";
import type { RequestConfig } from "./client.js";
import { buildSignedQuery } from "./signatures/wbiSignature.js";

const UNAVAILABLE_CODES = new Set([404, -404, 62002, 62004, 62012]);

export interface SubtitleVideoPage {
  cid: bigint;
  page: number;
  part: string;
}

export interface SubtitleVideoView {
  aid: bigint;
  bvid: string;
  pages: SubtitleVideoPage[];
}

function isUnavailableCode(code: number): boolean {
  return UNAVAILABLE_CODES.has(code);
}

function normalizeSubtitleUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  return `https://${url}`;
}

export async function fetchSubtitleVideoView(
  client: AxiosInstance,
  aid: bigint,
): Promise<SubtitleVideoView | null> {
  const endRequest = subtitleApiRequestDurationSeconds.startTimer({
    endpoint: "view",
  });
  try {
    const response = await client.get<BiliVideoDetailResponse>("/view", {
      params: { aid: aid.toString() },
      ...({ metadata: { silent: true } } as RequestConfig),
    });

    if (response.data.code === 0) {
      const view = {
        aid: BigInt(response.data.data.aid),
        bvid: response.data.data.bvid,
        pages: response.data.data.pages.map((page) => ({
          cid: BigInt(page.cid),
          page: page.page,
          part: page.part,
        })),
      };
      subtitleApiRequestsTotal.inc({ endpoint: "view", result: "success" });
      return view;
    }

    if (isUnavailableCode(response.data.code)) {
      subtitleApiRequestsTotal.inc({
        endpoint: "view",
        result: "unavailable",
      });
      logger.debug(
        `Subtitle view API returned unavailable code ${response.data.code} for aid ${aid}`,
      );
      return null;
    }

    throw new Error(
      `Subtitle view API error for aid ${aid}: code ${response.data.code}`,
    );
  } catch (error) {
    subtitleApiRequestsTotal.inc({ endpoint: "view", result: "error" });
    throw error;
  } finally {
    endRequest();
  }
}

export async function fetchPlayerSubtitleTracks(
  client: AxiosInstance,
  bvid: string,
  cid: bigint,
): Promise<BiliSubtitleTrackInfo[]> {
  const query = await buildSignedQuery({ bvid, cid: cid.toString() });
  let endRequest: (() => number) | null = null;
  try {
    endRequest = subtitleApiRequestDurationSeconds.startTimer({
      endpoint: "player_wbi_v2",
    });
    const response = await client.get<BiliPlayerWbiV2Response>(
      `/wbi/v2?${query}`,
      {
        ...({ metadata: { silent: true } } as RequestConfig),
      },
    );

    if (response.data.code !== 0) {
      throw new Error(
        `Player subtitle API error for ${bvid}/${cid}: code ${response.data.code}`,
      );
    }

    subtitleApiRequestsTotal.inc({
      endpoint: "player_wbi_v2",
      result: "success",
    });
    return response.data.data?.subtitle?.subtitles ?? [];
  } catch (error) {
    subtitleApiRequestsTotal.inc({
      endpoint: "player_wbi_v2",
      result: "error",
    });
    throw error;
  } finally {
    endRequest?.();
  }
}

export async function fetchSubtitleJson(
  subtitleUrl: string,
): Promise<BiliSubtitleJson> {
  const endRequest = subtitleApiRequestDurationSeconds.startTimer({
    endpoint: "subtitle_json",
  });
  try {
    const url = normalizeSubtitleUrl(subtitleUrl);
    const response = await axios.get<BiliSubtitleJson>(url, {
      headers: {
        Referer: "https://www.bilibili.com/",
      },
    });

    if (!Array.isArray(response.data.body)) {
      throw new Error(`Invalid subtitle JSON from ${url}`);
    }

    subtitleApiRequestsTotal.inc({
      endpoint: "subtitle_json",
      result: "success",
    });
    return response.data;
  } catch (error) {
    subtitleApiRequestsTotal.inc({
      endpoint: "subtitle_json",
      result: "error",
    });
    throw error;
  } finally {
    endRequest();
  }
}
