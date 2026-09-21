import type {
  CallRecord,
  Finding,
  TaskSummaryGroup,
  TaskSummaryCategory,
  TestTask,
} from '../../../shared/types';
import { findingCategory } from '../../lib/presentation';

export interface ResolvedIssueGroup extends TaskSummaryGroup {
  findings: Finding[];
}

export function currentFindings(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.state !== 'dismissed');
}

export function reviewSummaryLabel(
  calls: CallRecord[],
  issueCount: number,
  hasAssertions: boolean,
): string {
  if (issueCount) return `${issueCount} 类问题`;
  if (calls.some((call) => call.evaluationStatus === 'complete')) return '0 类候选问题';
  if (calls.some((call) => call.evaluationStatus === 'pending')) return '评审中';
  if (calls.some((call) => call.evaluationStatus === 'unavailable')) return '评审不可用';
  if (!hasAssertions) return '未配置业务评审';
  if (calls.some((call) => ['completed', 'error', 'interrupted', 'stopped'].includes(call.status)))
    return '等待评审';
  return '尚未评审';
}

export function summaryIsStale(task: TestTask, calls: CallRecord[], findings: Finding[]): boolean {
  const summary = task.summary;
  if (!summary) return true;
  if (summary.resultRevision !== (task.resultRevision ?? 0)) return true;
  const reviewed = calls
    .filter((call) => call.evaluationStatus === 'complete')
    .map((call) => call.id)
    .sort();
  const activeFindingIds = currentFindings(findings)
    .map((finding) => finding.id)
    .sort();
  return (
    reviewed.join('\n') !== [...summary.reviewedCallIds].sort().join('\n') ||
    activeFindingIds.join('\n') !== [...summary.findingIds].sort().join('\n')
  );
}

export function resolvedIssueGroups(task: TestTask, findings: Finding[]): ResolvedIssueGroup[] {
  const active = currentFindings(findings);
  const byId = new Map(active.map((finding) => [finding.id, finding]));
  const summaryMatchesCurrentFindings =
    task.summary &&
    task.summary.resultRevision === (task.resultRevision ?? 0) &&
    [...task.summary.findingIds].sort().join('\n') ===
      active
        .map((finding) => finding.id)
        .sort()
        .join('\n');
  if (task.summary && summaryMatchesCurrentFindings) {
    const resolved = task.summary.groups
      .map((group) => ({
        ...group,
        findings: group.findingIds
          .map((findingId) => byId.get(findingId))
          .filter((finding): finding is Finding => !!finding),
      }))
      .filter((group) => group.findings.length);
    if (resolved.length) return resolved;
  }

  const groups = new Map<string, ResolvedIssueGroup>();
  for (const finding of active) {
    const category = findingCategory(finding) as TaskSummaryCategory;
    const key = `${category}:${finding.title.trim().toLocaleLowerCase()}`;
    const current = groups.get(key);
    if (current) {
      current.findingIds.push(finding.id);
      if (!current.callIds.includes(finding.callId)) current.callIds.push(finding.callId);
      current.findings.push(finding);
      if (
        finding.severity === 'high' ||
        (finding.severity === 'medium' && current.severity === 'low')
      )
        current.severity = finding.severity;
    } else
      groups.set(key, {
        id: `fallback:${groups.size + 1}`,
        title: finding.title,
        detail: finding.detail,
        severity: finding.severity,
        category,
        findingIds: [finding.id],
        callIds: [finding.callId],
        findings: [finding],
      });
  }
  return [...groups.values()];
}

export function callResult(call: CallRecord, findings: Finding[], hasAssertions: boolean): string {
  if (call.status === 'connecting') return '连接中';
  if (call.status === 'running') return '通话中';
  if (call.status === 'error' || call.status === 'interrupted') return call.error || '连接失败';
  if (call.evaluationStatus === 'pending') return '评审中';
  if (call.evaluationStatus === 'unavailable') return '评审不可用';
  if (call.evaluationOverall === 'pass') return '通过';
  if (call.evaluationOverall === 'inconclusive') return '无法判定';
  if (call.evaluationOverall === 'fail') {
    const titles = currentFindings(findings)
      .filter((finding) => finding.callId === call.id)
      .map((finding) => finding.title);
    return titles.length ? [...new Set(titles)].join('；') : '未通过（问题已忽略）';
  }
  if (call.evaluationStatus === 'complete') {
    const legacyTitles = currentFindings(findings)
      .filter((finding) => finding.callId === call.id)
      .map((finding) => finding.title);
    return legacyTitles.length ? [...new Set(legacyTitles)].join('；') : '旧版结果未区分';
  }
  return hasAssertions ? '等待评审' : '未配置业务评审';
}

export function jevResult(call: CallRecord): string {
  const result = call.jevEvaluation;
  if (!result) return '未评估';
  if (result.status === 'pending') return '评估中';
  if (result.status === 'unavailable') return '暂不可用';
  return result.overall === 'pass' ? '通过' : result.overall === 'fail' ? '未通过' : '无法判定';
}
