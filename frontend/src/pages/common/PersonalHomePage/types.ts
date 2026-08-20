import type { AppError } from '@/libs/http/appError';

export type HomeRole = 'student' | 'teacher';

export type HomeStatTone = 'blue' | 'violet' | 'emerald' | 'coral';

export interface HomeStat {
  key: string;
  label: string;
  value: string;
  detail?: string;
  tone: HomeStatTone;
}

export interface HomeActionItem {
  id: string;
  title: string;
  description: string;
  href: string;
  progress?: number;
  meta?: string;
  tone: HomeStatTone;
}

export interface HomeRecentItem {
  id: string;
  title: string;
  description: string;
  timestamp: string;
  href: string;
  status: 'active' | 'completed' | 'paused' | 'neutral';
}

export interface HomeAffiliation {
  title: string;
  subtitle: string;
  detail?: string;
  href: string;
  actionLabel: string;
  empty: boolean;
  unavailable?: boolean;
}

export interface PersonalHomeData {
  role: HomeRole;
  primaryHref: string;
  primaryLabel: string;
  primaryContext: string;
  stats: HomeStat[];
  actions: HomeActionItem[];
  recentItems: HomeRecentItem[];
  affiliation: HomeAffiliation;
  failedSections: string[];
  sectionErrors: HomeSectionError[];
}

export interface HomeSectionError {
  section: string;
  error: AppError;
}
