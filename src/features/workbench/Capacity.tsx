import type { WorkbenchState } from '../../../shared/types';

export function Capacity({ state }: { state: WorkbenchState }) {
  const running = state.tasks.filter((task) => task.status === 'running');
  const requested = running.reduce((sum, task) => sum + task.concurrency, 0);
  const percent = Math.round(
    (state.activeCalls / Math.max(1, state.settings.maxConcurrency)) * 100,
  );
  return (
    <section className="capacity capacity-card" aria-label="共享并发容量">
      <div className="capacity-copy">
        <div className="capacity-eyebrow">
          <span>共享并发容量</span>
        </div>
        <h2>
          <strong>{state.activeCalls}</strong> / {state.settings.maxConcurrency} 路正在通话
        </h2>
        <p>所有任务共享本机并发额度；暂停后停止新派发，当前通话结束后释放。</p>
      </div>
      <div className="capacity-visual">
        <div className="capacity-labels">
          <span />
          <strong>{percent}%</strong>
        </div>
        <div
          className={`capacity-slots ${state.settings.maxConcurrency > 20 ? 'compact' : ''}`}
          aria-hidden="true"
        >
          {Array.from({ length: state.settings.maxConcurrency }, (_, index) => (
            <i key={index} className={index < state.activeCalls ? 'occupied' : ''} />
          ))}
        </div>
        <div className="capacity-bottom">
          <span>
            {running.length ? `${running.length} 个任务正在调度 · 请求 ${requested} 路并发` : null}
          </span>
          <span>{Math.max(0, state.settings.maxConcurrency - state.activeCalls)} 路空闲</span>
        </div>
      </div>
    </section>
  );
}
