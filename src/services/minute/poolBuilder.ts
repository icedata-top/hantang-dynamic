import { config } from "../../config";
import { Database } from "../../database";

export class MinutePoolBuilder {
  private db = Database.getInstance();

  async refreshFromDaily(aids?: bigint[]): Promise<number> {
    return this.db.refreshVideoCollectionStateFromDaily(aids);
  }

  async enqueueDueTasks(): Promise<{ minute: number; gate: number }> {
    const minute = await this.db.enqueueVideoCollectionTasks(
      new Date(),
      config.minute.maxAttempts,
    );
    const gate = await this.db.enqueueVideoCollectionGateTasks(new Date(), {
      gateLeadTimeMinutes: config.minute.gateLeadTimeMinutes,
      gateMinLeadRatio: config.minute.gateMinLeadRatio,
      gateMaxLeadViews: config.minute.gateMaxLeadViews,
      maxAttempts: config.minute.maxAttempts,
    });
    return { minute, gate };
  }
}
