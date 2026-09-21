import type { ReactNode } from 'react';
import type { Finding, HandlingAssessment } from '../../../shared/types';
import { categoryNames, findingCategory, handlingNames } from '../../lib/presentation';

export function FindingScenarioLabel({ finding }: { finding: Finding }) {
  return finding.source === 'judge' && (finding.evaluatorVersion ?? 0) < 2 ? (
    <span className="scenario-review-label">场景待核实</span>
  ) : null;
}

export function FindingBadge({ finding }: { finding: Finding }) {
  const category = findingCategory(finding);
  return <span className={`finding-category category-${category}`}>{categoryNames[category]}</span>;
}

export function HandlingResult({
  handling,
  compact = false,
}: {
  handling?: HandlingAssessment;
  compact?: boolean;
}) {
  if (!handling) return null;
  return (
    <span className={`handling-result handling-${handling.status} ${compact ? 'compact' : ''}`}>
      <strong>{handlingNames[handling.status]}</strong>
      <span>{handling.reason}</span>
    </span>
  );
}

export function FindingGroups({
  findings,
  render,
}: {
  findings: Finding[];
  render: (finding: Finding) => ReactNode;
}) {
  const main = findings.filter((finding) => findingCategory(finding) !== 'observation');
  const observations = findings.filter((finding) => findingCategory(finding) === 'observation');
  return (
    <>
      {main.map(render)}
      {!!observations.length && (
        <section className="supplemental-findings" aria-label="补充观察">
          <div className="supplemental-heading">
            <h4>
              补充观察 <span>{observations.length}</span>
            </h4>
            <span>低优先级 · 不计入主目标</span>
          </div>
          {observations.map(render)}
        </section>
      )}
    </>
  );
}
