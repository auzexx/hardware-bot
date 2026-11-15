import { DurableObject } from 'cloudflare:workers';
import { CloudMonitor } from './cloudflare-monitor.mjs';

export class HardwareMonitor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.monitor = new CloudMonitor(ctx.storage, env);
  }

  tick() {
    return this.monitor.tick();
  }
}

export default {
  async scheduled(_controller, env) {
    // Keep the Free-plan cron handler small; parsing and persistence run in the DO.
    if (!env.MONITOR_MODE || env.MONITOR_MODE === 'disabled') return;
    await env.MONITOR.getByName('hardware-bot-v1').tick();
  },
  fetch() {
    // No public route can send messages, change filters or read state.
    return new Response('Not found', { status: 404 });
  },
};
