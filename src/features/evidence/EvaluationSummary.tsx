import { ChevronDown } from 'lucide-react';
import type { AssessmentCategory } from '../../../shared/types';
import { friendlyEvaluationError, scenarioNames } from '../../lib/presentation';
import type { AssertionResult, CallDetail } from '../../types';
import { HandlingResult } from '../findings/FindingPresentation';

export function isRetiredEvaluation(evaluation: CallDetail['evaluation']): boolean {
  return (
    !!evaluation && (evaluation.source === 'pi_recording_crosscheck' || 'audioReview' in evaluation)
  );
}

export function EvaluationSummary({ detail }: { detail: CallDetail }) {
  const evaluation = detail.evaluation;
  if (isRetiredEvaluation(evaluation)) {
    const goals = evaluation?.rules?.assertions ?? detail.task?.rules.assertions ?? [];
    return (
      <section className="evaluation-block">
        <h3>测试目标</h3>
        {goals.map((goal, index) => (
          <p key={index}>{goal}</p>
        ))}
        <h3>测试结果</h3>
        <p>结果待更新</p>
      </section>
    );
  }
  if (!evaluation)
    return (
      <section className="evaluation-block">
        <h3>原需求主目标</h3>
        <p>
          {detail.call.evaluationStatus === 'pending' || detail.reviewPending
            ? 'Pi 正在逐项评估，结果将在这里更新。'
            : detail.call.evaluationStatus === 'unavailable'
              ? '本次业务评估不可用，请结合录音人工核对。'
              : '尚无业务评估结果。通话完成不代表测试通过。'}
        </p>
      </section>
    );
  const isCurrent = (evaluation.version ?? 0) >= 3;
  const checksScenario = (evaluation.version ?? 0) >= 2;
  const assertions = evaluation.judgment?.assertions ?? [];
  const categoryOf = (assertion: AssertionResult): AssessmentCategory | 'legacy' =>
    isCurrent && assertion.category ? assertion.category : 'legacy';
  const scenarioBlocksJudgment = (assertion: AssertionResult) =>
    checksScenario &&
    !['observed', 'not_applicable'].includes(assertion.scenario?.status ?? 'uncertain');
  const statusOf = (assertion: AssertionResult) =>
    scenarioBlocksJudgment(assertion) ? 'inconclusive' : assertion.status;
  const main = assertions.filter((assertion) => categoryOf(assertion) !== 'observation');
  const observations = assertions.filter((assertion) => categoryOf(assertion) === 'observation');
  const failedAgent = main.some(
    (assertion) => categoryOf(assertion) === 'agent_behavior' && statusOf(assertion) === 'fail',
  );
  const failedGoal = main.some(
    (assertion) => categoryOf(assertion) === 'business_outcome' && statusOf(assertion) === 'fail',
  );
  const allPass = main.length > 0 && main.every((assertion) => statusOf(assertion) === 'pass');
  const overall = failedAgent
    ? { label: 'AI 客服问题', tone: 'fail' }
    : failedGoal
      ? { label: '目标未完成', tone: 'inconclusive' }
      : allPass
        ? { label: isCurrent ? '主目标检查通过' : '旧版检查通过', tone: 'pass' }
        : { label: isCurrent ? '仍有目标待核实' : '旧版未区分', tone: 'inconclusive' };
  const titles = evaluation.rules?.assertions ?? detail.task?.rules.assertions ?? [];
  const renderAssertion = (assertion: AssertionResult) => {
    const category = categoryOf(assertion);
    const scenario = assertion.scenario;
    const blocked = scenarioBlocksJudgment(assertion);
    const status = statusOf(assertion);
    const label =
      category === 'observation'
        ? '补充观察'
        : category === 'business_outcome'
          ? status === 'pass'
            ? '目标已完成'
            : status === 'fail'
              ? '目标未完成'
              : '目标待核实'
          : category === 'agent_behavior'
            ? status === 'pass'
              ? 'AI 客服行为符合要求'
              : status === 'fail'
                ? 'AI 客服问题'
                : 'AI 客服行为待核实'
            : status === 'pass'
              ? '旧版判定通过'
              : status === 'fail'
                ? '旧版判定未通过'
                : '旧版无法判定';
    return (
      <div className={`assertion-result category-${category}`} key={assertion.assertionIndex}>
        <strong>
          {titles[assertion.assertionIndex] ?? `检查项 ${assertion.assertionIndex + 1}`}
        </strong>
        <span className={`evaluation-outcome ${status}`}>{label}</span>
        <p>{assertion.reason}</p>
        {isCurrent && <HandlingResult handling={assertion.handling} />}
        {checksScenario && (
          <details className={`scenario-result ${blocked ? 'unresolved' : ''}`} open={blocked}>
            <summary>
              {scenario ? (scenarioNames[scenario.status] ?? '场景证据不足') : '场景证据不足'}
              <ChevronDown size={12} />
            </summary>
            <p>{scenario?.reason || '未保存可核实的场景前提，不能据此判定本项。'}</p>
          </details>
        )}
      </div>
    );
  };
  return (
    <section className="evaluation-block">
      <h3>
        {isCurrent ? '原需求主目标' : '旧版评审检查项'}
        {!!main.length && <span className="assessment-count">{main.length} 项</span>}
        {evaluation.status === 'complete' && (
          <span className={`evaluation-outcome ${overall.tone}`}>{overall.label}</span>
        )}
      </h3>
      {!isCurrent && (
        <p className="inline-warning legacy-evaluation-warning">
          旧版评审未区分业务目标是否完成与 AI
          客服应对是否合理。以下保留原报告，尚未按新规则重新评审。
          {!checksScenario && '场景是否发生也需结合录音核实。'}
        </p>
      )}
      {evaluation.status === 'unavailable' ? (
        <p className="error-ink">
          {friendlyEvaluationError(evaluation.error || '评估服务暂不可用，请重试或人工核对。')}
        </p>
      ) : (
        <>
          <p>{evaluation.judgment?.summary}</p>
          {main.map(renderAssertion)}
          {!!observations.length && (
            <section className="evaluation-observations" aria-label="评审补充观察">
              <div className="supplemental-heading">
                <h4>
                  补充观察 <span>{observations.length}</span>
                </h4>
                <span>不计入主目标结果</span>
              </div>
              {observations.map(renderAssertion)}
            </section>
          )}
        </>
      )}
    </section>
  );
}
