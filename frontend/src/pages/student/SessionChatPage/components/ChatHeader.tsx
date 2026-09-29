import React from 'react';
import { Button } from '../../../../components/ui/Button';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { ModeConfig } from '../constants.tsx';

interface ChatHeaderProps {
  title?: string;
  currentMode: ModeConfig;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  rightSlot?: React.ReactNode;
}

export const ChatHeader = React.memo<ChatHeaderProps>(
  ({ title = '学习会话', sidebarOpen, onToggleSidebar, rightSlot }) => {
    return (
      <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onToggleSidebar} aria-label={sidebarOpen ? '关闭历史会话' : '展开历史会话'} title={sidebarOpen ? '关闭历史会话' : '展开历史会话'}>
            {sidebarOpen ? <PanelLeftClose className="w-5 h-5" /> : <PanelLeftOpen className="w-5 h-5" />}
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <span title={title} className="min-w-0 truncate text-sm font-semibold text-surface-900 dark:text-surface-100">
              {title}
            </span>
            <div className="shrink-0">{rightSlot}</div>
          </div>
        </div>
      </div>
    );
  }
);

ChatHeader.displayName = 'ChatHeader';
