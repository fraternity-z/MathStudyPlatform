/**
 * 教学概览报告导出器
 *
 * 支持 CSV / Markdown 两种格式
 * 全部在前端本地生成，不依赖后端
 */

import { saveAs } from 'file-saver';
import type { DashboardStats, TeacherAnalyticsData } from '@/modules/teacher/types/teacher';

// ==================== 类型定义 ====================

export type DashboardExportFormat = 'csv' | 'markdown';

export interface DashboardExportSections {
  /** 统计概览 */
  overview: boolean;
  /** 知识点掌握度 */
  knowledgePoints: boolean;
  /** 成绩排行榜 */
  topStudents: boolean;
  /** 本周学习活跃度 */
  weeklyActivity: boolean;
}

export interface DashboardExportOptions {
  format: DashboardExportFormat;
  sections: DashboardExportSections;
  timeRangeLabel: string;
}

// ==================== 工具函数 ====================

function formatDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}_${h}${min}`;
}

function escapeFormulaCell(value: string): string {
  const trimmed = value.trimStart();
  if (trimmed === '') return value;
  return ['=', '+', '-', '@'].includes(trimmed[0]) ? `'${value}` : value;
}

/** CSV 字段转义：防止公式注入，并包裹含逗号/引号/换行的字段 */
function csvEscape(value: string | number): string {
  const str = escapeFormulaCell(String(value));
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ==================== CSV 导出 ====================

export function buildDashboardCsvContent(
  stats: DashboardStats,
  analytics: TeacherAnalyticsData,
  options: DashboardExportOptions,
): string {
  const lines: string[] = [];

  if (options.sections.overview) {
    lines.push('# 统计概览');
    lines.push('指标,数值');
    lines.push(`总学生数,${stats.total_students}`);
    lines.push(`今日活跃率,${stats.active_today}%`);
    lines.push(`平均完成率,${analytics.overview.avg_completion_rate}%`);
    lines.push(`平均成绩,${analytics.overview.avg_score}`);
    lines.push(`平均学习时长,${analytics.overview.avg_study_hours}h`);
    lines.push('');
  }

  if (options.sections.knowledgePoints && analytics.knowledge_points.length > 0) {
    lines.push('# 知识点掌握度');
    lines.push('知识点,掌握度(%),学生人数');
    for (const kp of analytics.knowledge_points) {
      lines.push(`${csvEscape(kp.name)},${kp.mastery},${kp.student_count}`);
    }
    lines.push('');
  }

  if (options.sections.topStudents && analytics.top_students.length > 0) {
    lines.push('# 成绩排行榜');
    lines.push('排名,姓名,平均成绩');
    for (const s of analytics.top_students) {
      lines.push(`${s.rank},${csvEscape(s.name)},${s.avg_score}`);
    }
    lines.push('');
  }

  if (options.sections.weeklyActivity && analytics.weekly_activity.length > 0) {
    lines.push('# 本周学习活跃度');
    lines.push('日期,星期,活跃率(%)');
    for (const day of analytics.weekly_activity) {
      lines.push(`${day.date},${csvEscape(day.day_label)},${day.active_rate}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ==================== Markdown 导出 ====================

function buildMarkdownContent(
  stats: DashboardStats,
  analytics: TeacherAnalyticsData,
  options: DashboardExportOptions,
): string {
  const lines: string[] = [];

  lines.push('# 教学概览报告');
  lines.push('');
  lines.push(`> 导出时间: ${new Date().toLocaleString('zh-CN')}`);
  lines.push(`> 统计范围: ${options.timeRangeLabel}`);
  lines.push('');

  if (options.sections.overview) {
    lines.push('## 统计概览');
    lines.push('');
    lines.push('| 指标 | 数值 |');
    lines.push('|------|------|');
    lines.push(`| 总学生数 | ${stats.total_students} |`);
    lines.push(`| 今日活跃率 | ${stats.active_today}% |`);
    lines.push(`| 平均完成率 | ${analytics.overview.avg_completion_rate}% |`);
    lines.push(`| 平均成绩 | ${analytics.overview.avg_score} |`);
    lines.push(`| 平均学习时长 | ${analytics.overview.avg_study_hours}h |`);
    lines.push('');
  }

  if (options.sections.knowledgePoints && analytics.knowledge_points.length > 0) {
    lines.push('## 知识点掌握度分析');
    lines.push('');
    lines.push('| 知识点 | 掌握度 | 学生人数 |');
    lines.push('|--------|--------|----------|');
    for (const kp of analytics.knowledge_points) {
      lines.push(`| ${kp.name} | ${kp.mastery}% | ${kp.student_count} |`);
    }
    lines.push('');
  }

  if (options.sections.topStudents && analytics.top_students.length > 0) {
    lines.push('## 成绩排行榜');
    lines.push('');
    lines.push('| 排名 | 姓名 | 平均成绩 |');
    lines.push('|------|------|----------|');
    for (const s of analytics.top_students) {
      lines.push(`| ${s.rank} | ${s.name} | ${s.avg_score} |`);
    }
    lines.push('');
  }

  if (options.sections.weeklyActivity && analytics.weekly_activity.length > 0) {
    lines.push('## 本周学习活跃度');
    lines.push('');
    lines.push('| 日期 | 星期 | 活跃率 |');
    lines.push('|------|------|--------|');
    for (const day of analytics.weekly_activity) {
      lines.push(`| ${day.date} | ${day.day_label} | ${day.active_rate}% |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ==================== 统一导出入口 ====================

/**
 * 导出教学概览报告
 */
export function exportDashboardReport(
  stats: DashboardStats,
  analytics: TeacherAnalyticsData,
  options: DashboardExportOptions,
): void {
  const filename = `教学概览报告_${formatDate()}`;

  if (options.format === 'csv') {
    const content = buildDashboardCsvContent(stats, analytics, options);
    // 添加 BOM 头确保 Excel 正确识别 UTF-8
    const bom = '\uFEFF';
    const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, `${filename}.csv`);
  } else {
    const content = buildMarkdownContent(stats, analytics, options);
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    saveAs(blob, `${filename}.md`);
  }
}
