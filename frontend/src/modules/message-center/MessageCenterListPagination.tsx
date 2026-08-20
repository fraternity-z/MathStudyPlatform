import { type FormEvent, useEffect, useId, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';

type PageItem = number | 'dots';

function getPageItems(currentPage: number, totalPages: number): PageItem[] {
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (currentPage <= 3) return [1, 2, 3, 'dots', totalPages];
  if (currentPage >= totalPages - 2) return [1, 'dots', totalPages - 2, totalPages - 1, totalPages];
  return [1, 'dots', currentPage, 'dots', totalPages];
}

interface MessageCenterListPaginationProps {
  currentPage: number;
  totalItems: number;
  pageSize: number;
  disabled?: boolean;
  onPageChange: (page: number) => void;
}

export function MessageCenterListPagination({
  currentPage,
  totalItems,
  pageSize,
  disabled = false,
  onPageChange,
}: MessageCenterListPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const [pageInput, setPageInput] = useState(String(currentPage));
  const pageInputID = useId();
  const pages = useMemo(() => getPageItems(currentPage, totalPages), [currentPage, totalPages]);

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  if (totalItems === 0) return null;

  const submitPage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const page = Number(pageInput);
    if (!Number.isInteger(page)) {
      setPageInput(String(currentPage));
      return;
    }
    onPageChange(Math.min(Math.max(page, 1), totalPages));
  };

  return (
    <div className="shrink-0 border-t border-surface-100 px-2 py-2 dark:border-surface-800">
      <nav aria-label="列表分页" className="flex flex-wrap items-center justify-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-1.5"
          disabled={disabled || currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
          aria-label="上一页"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        {pages.map((page, index) => page === 'dots' ? (
          <span key={`dots-${index}`} className="px-1 text-sm text-surface-400" aria-hidden="true">...</span>
        ) : (
          <Button
            key={page}
            variant={page === currentPage ? 'primary' : 'ghost'}
            size="sm"
            className="h-8 min-w-8 px-1.5"
            disabled={disabled}
            onClick={() => onPageChange(page)}
            aria-label={`第 ${page} 页`}
            aria-current={page === currentPage ? 'page' : undefined}
          >
            {page}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-1.5"
          disabled={disabled || currentPage >= totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          aria-label="下一页"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </nav>
      <form className="mt-1 flex items-center justify-center gap-1.5 text-sm text-surface-500 dark:text-surface-400" onSubmit={submitPage}>
        <span>第 {currentPage} / {totalPages} 页</span>
        <label htmlFor={pageInputID} className="sr-only">跳转页码</label>
        <input
          id={pageInputID}
          type="number"
          min={1}
          max={totalPages}
          value={pageInput}
          disabled={disabled}
          onChange={(event) => setPageInput(event.target.value)}
          className="h-8 w-11 rounded border border-surface-200 bg-transparent px-1 text-center text-sm text-surface-900 outline-none transition-colors focus:border-primary-500 focus:ring-1 focus:ring-primary-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-surface-700 dark:text-surface-100"
        />
        <Button type="submit" variant="ghost" size="sm" className="h-8 px-1.5" disabled={disabled}>跳转</Button>
      </form>
    </div>
  );
}
