import { writeFileSync, readFileSync, existsSync } from 'fs';

export class StateManager {
    private filePath: string;
    private state: {
        lastDynamicId: string;
        lastUpdateTime: number;
    };

    constructor(filePath: string = './state.json') {
        this.filePath = filePath;
        this.state = this.loadState();
    }

    private loadState() {
        if (existsSync(this.filePath)) {
            return JSON.parse(readFileSync(this.filePath, 'utf-8'));
        }
        return { lastDynamicId: '0', lastUpdateTime: Date.now() };
    }

    saveState() {
        writeFileSync(this.filePath, JSON.stringify(this.state));
    }

    getLastDynamicId(): string {
        return this.state.lastDynamicId;
    }

    updateLastDynamicId(id: string) {
        this.state.lastDynamicId = id;
        this.state.lastUpdateTime = Date.now();
        this.saveState();
    }

    isWithinSevenDays(): boolean {
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        return (Date.now() - this.state.lastUpdateTime) < sevenDays;
    }
}