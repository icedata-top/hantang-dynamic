import { writeFileSync } from "fs";
import { parse } from "json2csv";

interface VideoData {
  aid: number;
  bvid: string;
  pubdate: number;
  title: string;
  description: string;
  tag: string;
  pic: string;
  type_id: number;
  user_id: number;
}

export function saveToCSV(videoData: VideoData[], filePath: string): void {
  const csv = parse(videoData);
  writeFileSync(filePath, csv);
}
