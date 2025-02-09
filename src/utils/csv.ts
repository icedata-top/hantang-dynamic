import { writeFileSync } from "fs";
import { parse } from "json2csv";
import { VideoData } from "../core/types";
import { logger } from "./logger";

const fields = [
  { label: "AID", value: "aid" },
  { label: "BVID", value: "bvid" },
  { label: "发布时间", value: "pubdate" },
  { label: "标题", value: "title" },
  { label: "描述", value: "description" },
  { label: "标签", value: "tag" },
  { label: "封面图", value: "pic" },
  { label: "分类ID", value: "type_id" },
  { label: "用户ID", value: "user_id" },
];

export const saveAsCSV = (data: VideoData[], filename: string) => {
  try {
    const csv = parse(data, { fields });
    writeFileSync(filename, `\ufeff${csv}`, "utf-8");
    logger.info(`已保存 ${data.length} 条记录到 ${filename}`);
  } catch (error) {
    logger.error("CSV 保存失败:", error);
  }
};
