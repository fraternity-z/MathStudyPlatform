import type { ChatMode } from '@/modules/session/types';
import { GraduationCap, MessageCircle, Target, Lightbulb, Calculator, TrendingUp, Brain, HelpCircle } from 'lucide-react';

export interface ModeConfig {
  id: ChatMode;
  name: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}

export interface QuickAction {
  icon: React.ReactNode;
  label: string;
  prompt: string;
}

export const CHAT_MODES: ModeConfig[] = [
  {
    id: 'study',
    name: '知识学习',
    description: '分段讲解，检查理解，保存进度',
    icon: <GraduationCap className="w-5 h-5" />,
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-900/30',
  },
  {
    id: 'chat',
    name: '问题答疑',
    description: '围绕具体疑问，解答与深入讲解',
    icon: <MessageCircle className="w-5 h-5" />,
    color: 'text-emerald-600 dark:text-emerald-400',
    bgColor: 'bg-emerald-50 dark:bg-emerald-900/30',
  },
  {
    id: 'practice',
    name: '习题练习',
    description: '选题作答，提交判定，查看解析',
    icon: <Target className="w-5 h-5" />,
    color: 'text-orange-600 dark:text-orange-400',
    bgColor: 'bg-orange-50 dark:bg-orange-900/30',
  },
];

export const ANSWER_ACTIONS: QuickAction[] = [
  { icon: <Lightbulb className="w-4 h-4" />, label: '详细讲解', prompt: '请围绕刚才的问题再详细讲解，指出适用条件和常见误区。' },
  { icon: <Calculator className="w-4 h-4" />, label: '展开推导', prompt: '请展开刚才回答中的关键推导，解释每一步的依据。' },
  { icon: <Brain className="w-4 h-4" />, label: '举个例子', prompt: '请用一个具体例子帮助我理解刚才的知识，并说明容易混淆的地方。' },
];

export const QUICK_ACTIONS: QuickAction[] = [
  { icon: <Calculator className="w-4 h-4" />, label: '解方程', prompt: '帮我解这个方程' },
  { icon: <TrendingUp className="w-4 h-4" />, label: '求导数', prompt: '帮我求这个函数的导数' },
  { icon: <Brain className="w-4 h-4" />, label: '求积分', prompt: '帮我计算这个积分' },
  { icon: <HelpCircle className="w-4 h-4" />, label: '解释概念', prompt: '请解释一下' },
];
