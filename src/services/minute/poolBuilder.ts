import { config } from "../../config";
import { Database } from "../../database";

export class MinutePoolBuilder {
  private db = Database.getInstance();

  async refreshFromDaily(aids?: bigint[]): Promise<number> {
    return this.db.refreshVideoCollectionStateFromDaily(aids);
  }

  async enqueueDueMinuteTasks(): Promise<number> {
    return this.db.enqueueVideoCollectionTasks(
      new Date(),
      config.minute.maxAttempts,
    );
  }

  async enqueueGateTasks(): Promise<number> {
    return this.db.enqueueVideoCollectionGateTasks(new Date(), {
      gateLeadTimeMinutes: config.minute.gateLeadTimeMinutes,
      gateMinLeadRatio: config.minute.gateMinLeadRatio,
      gateMaxLeadViews: config.minute.gateMaxLeadViews,
      maxAttempts: config.minute.maxAttempts,
    });
  }
}
