import { Parser } from "@json2csv/plainjs";
import { parse as parseCSV } from "csv-parse/sync"; // 新增导入
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../../config";
import type { VideoData } from "../../core/types";
import { logger } from "../logger";

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
    const filepath = config.export.csv.path;
    const dirPath = dirname(config.export.csv.path);

    // Ensure directory exists
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    let allData: VideoData[] = [...data];

    if (existsSync(filepath)) {
      const existingContent = readFileSync(filepath, "utf-8");
      const contentWithoutBOM =
        existingContent.charCodeAt(0) === 0xfeff
          ? existingContent.substring(1)
          : existingContent;

      if (contentWithoutBOM.trim()) {
        try {
          const existingData = parseCSV(contentWithoutBOM, {
            columns: true,
            skip_empty_lines: true,
          }) as VideoData[];

          const dataMap = new Map<string, VideoData>();

          existingData.forEach((item) => {
            if (item.bvid) {
              dataMap.set(item.bvid, item);
            }
          });

          data.forEach((item) => {
            dataMap.set(item.bvid, item);
          });

          allData = Array.from(dataMap.values());
        } catch (parseError) {
          logger.error("解析现有CSV文件失败:", parseError);
        }
      }
    }
    const parser = new Parser({ fields });
    const csv = parser.parse(allData);
    writeFileSync(filepath, `\ufeff${csv}`, "utf-8");
    logger.info(
      `已累加保存 ${data.length} 条新记录，共 ${allData.length} 条记录到 ${filepath}`,
    );
    return true;
  } catch (error) {
    logger.error("CSV 保存失败:", error);
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return false;
  }
};
