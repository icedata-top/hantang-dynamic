import type { BiliSubtitleLine } from "../types/bilibili/subtitle.js";

function formatSrtTime(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;

  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(secs).padStart(2, "0")},` +
    `${String(ms).padStart(3, "0")}`
  );
}

function formatLrcTime(seconds: number): string {
  const totalCs = Math.round(seconds * 100);
  const minutes = Math.floor(totalCs / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;

  return (
    `[${String(minutes).padStart(2, "0")}:` +
    `${String(secs).padStart(2, "0")}.` +
    `${String(cs).padStart(2, "0")}]`
  );
}

export function toSrt(body: BiliSubtitleLine[]): string {
  if (body.length === 0) return "";

  const entries = body
    .map((line, index) => {
      const from = formatSrtTime(line.from);
      const to = formatSrtTime(line.to);
      return `${index + 1}\n${from} --> ${to}\n${line.content}`;
    })
    .join("\n\n");

  return `${entries}\n`;
}

export function toTxt(body: BiliSubtitleLine[]): string {
  return body.map((line) => line.content).join("\n");
}

export function toLrc(body: BiliSubtitleLine[]): string {
  return body
    .map((line) => `${formatLrcTime(line.from)}${line.content}`)
    .join("\n");
}
