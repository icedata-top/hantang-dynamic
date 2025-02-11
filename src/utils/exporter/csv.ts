import { writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { parse } from "json2csv";
import { VideoData } from "../../core/types";
import { logger } from "../logger";
import { config } from "../../core/config";

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

export const saveAsCSV = (data: VideoData[]) => {
  try {
    const filepath = config.CSV_PATH;
    const dirPath = dirname(config.CSV_PATH);

    // Ensure directory exists
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    const csv = parse(data, { fields });
    writeFileSync(filepath, `\ufeff${csv}`, "utf-8");
    logger.info(`已保存 ${data.length} 条记录到 ${filepath}`);
    return true;
  } catch (error) {
    logger.error("CSV 保存失败:", error);
    return false;
  }
};
