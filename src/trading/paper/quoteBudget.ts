import { logger } from "../../logger";

/** In-process daily quote cap (UTC day). */
export class QuoteBudget {
  private day = "";
  private used = 0;
  private warned = false;

  constructor(
    private readonly maxPerDay: number,
    private readonly now: () => Date = () => new Date()
  ) {}

  tryConsume(): boolean {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
      this.warned = false;
    }
    if (this.used >= this.maxPerDay) {
      if (!this.warned) {
        logger.warn({ maxPerDay: this.maxPerDay }, "paper strategies hit their daily quote cap — marks skipped until UTC midnight");
        this.warned = true;
      }
      return false;
    }
    this.used++;
    return true;
  }

  get usedToday(): number {
    return this.used;
  }
}
