import React from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '../../../components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Button } from '../../../components/ui/Button';
import { Pagination } from '../../../components/ui/Pagination';
import { Plus, Download, Upload } from 'lucide-react';
import { useQuestionBank } from './hooks/useQuestionBank';
import { QuestionStatsCards } from './components/QuestionStatsCards';
import { QuestionFilters } from './components/QuestionFilters';
import { BatchActionBar } from './components/BatchActionBar';
import { QuestionTable } from './components/QuestionTable';
import { QuestionImportModal } from './components/QuestionImportModal';
import { QuestionExportModal } from './components/QuestionExportModal';

interface QuestionBankPaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

const QuestionBankPagination: React.FC<QuestionBankPaginationProps> = ({
  currentPage,
  totalPages,
  onPageChange,
}) => {
  const [pageInput, setPageInput] = React.useState(String(currentPage));

  React.useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  const submitPage = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const page = Number(pageInput);
    if (!Number.isInteger(page)) {
      setPageInput(String(currentPage));
      return;
    }
    onPageChange(Math.min(Math.max(page, 1), totalPages));
  };

  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
      <span className="order-last whitespace-nowrap text-sm text-surface-500 dark:text-surface-400 sm:order-none">
        第 {currentPage} / {totalPages} 页
      </span>
      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={onPageChange}
        className="mx-0 w-auto"
      />
      <form
        className="flex items-center gap-1.5 text-sm text-surface-500 dark:text-surface-400"
        onSubmit={submitPage}
      >
        <label htmlFor="question-bank-page-input" className="whitespace-nowrap">跳转到</label>
        <input
          id="question-bank-page-input"
          type="number"
          min={1}
          max={totalPages}
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value)}
          className="h-8 w-12 rounded border border-surface-200 bg-transparent px-1 text-center text-sm text-surface-900 shadow-none outline-none transition-colors focus:border-primary-500 focus:ring-1 focus:ring-primary-500/20 dark:border-surface-700 dark:text-surface-100"
          aria-label="页码"
        />
        <span>/ {totalPages}</span>
        <Button type="submit" variant="ghost" size="sm" className="h-8 px-2 shadow-none">确定</Button>
      </form>
    </div>
  );
};

export const QuestionBankPage: React.FC = () => {
  const navigate = useNavigate();
  const qb = useQuestionBank();

  return (
    <MainLayout>
      <div className="container mx-auto px-6 py-8 max-w-7xl">
        {/* 页面标题 */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-surface-900 dark:text-surface-100 mb-2">
              题库管理
            </h1>
            <p className="text-surface-500 dark:text-surface-400">
              管理和组织你的数学题库，共 {qb.total} 道题目
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => qb.setImportModalOpen(true)}>
              <Upload className="h-4 w-4 mr-2" /> 导入题目
            </Button>
            <Button variant="outline" onClick={() => qb.setExportModalOpen(true)} disabled={qb.total === 0}>
              <Download className="h-4 w-4 mr-2" /> 导出题目
            </Button>
            <Button onClick={() => navigate('/teacher/question/new')}>
              <Plus className="h-4 w-4 mr-2" /> 新建题目
            </Button>
          </div>
        </div>

        {qb.stats && <QuestionStatsCards stats={qb.stats} />}

        <QuestionFilters
          searchTerm={qb.searchTerm} onSearchChange={qb.setSearchTerm}
          selectedDifficulty={qb.selectedDifficulty} onDifficultyChange={qb.setSelectedDifficulty}
          selectedType={qb.selectedType} onTypeChange={qb.setSelectedType}
          selectedStatus={qb.selectedStatus} onStatusChange={qb.setSelectedStatus}
          groups={qb.groups} selectedGroup={qb.selectedGroup} onGroupChange={qb.setSelectedGroup}
          hasActiveFilters={qb.hasActiveFilters} onReset={qb.resetFilters}
        />

        {qb.selectedQuestions.length > 0 && (
          <BatchActionBar
            selectedCount={qb.selectedQuestions.length}
            loading={qb.loading}
            onPublish={qb.handleBatchPublish}
            onDuplicate={qb.handleBatchDuplicate}
            onDelete={qb.handleBatchDelete}
          />
        )}

        {qb.error && (
          <RequestErrorNotice
            error={qb.error}
            onRetry={() => void qb.loadQuestions()}
            onRefresh={() => void qb.loadQuestions()}
            className="mb-4"
          />
        )}
        {qb.statsError ? (
          <RequestErrorNotice
            error={qb.statsError}
            onRetry={() => void qb.loadStats()}
            onRefresh={() => void qb.loadStats()}
            className="mb-4"
          />
        ) : null}
        {qb.groupsError ? (
          <RequestErrorNotice
            error={qb.groupsError}
            onRetry={() => void qb.loadGroups()}
            onRefresh={() => void qb.loadGroups()}
            className="mb-4"
          />
        ) : null}

        <QuestionTable
          questions={qb.questions} loading={qb.loading}
          selectedQuestions={qb.selectedQuestions}
          onToggleSelect={qb.toggleSelectQuestion}
          onToggleSelectAll={qb.toggleSelectAll}
          openMenuId={qb.openMenuId} onSetOpenMenuId={qb.setOpenMenuId}
          menuRef={qb.menuRef}
          onDuplicate={qb.handleDuplicate}
          onStatusChange={qb.handleStatusChange}
          onDailyCandidateChange={qb.handleDailyCandidateChange}
          dailyCandidateUpdatingIds={qb.dailyCandidateUpdatingIds}
          onDelete={qb.handleDeleteSingle}
        />

        {qb.total > 0 && (
          <div className="mt-6 flex justify-center">
            <QuestionBankPagination
              currentPage={qb.currentPage}
              totalPages={Math.ceil(qb.total / qb.pageSize)}
              onPageChange={qb.setCurrentPage}
            />
          </div>
        )}

        <QuestionImportModal
          isOpen={qb.importModalOpen}
          onClose={() => qb.setImportModalOpen(false)}
          onImportComplete={() => { qb.loadQuestions(); qb.loadStats(); }}
        />
        <QuestionExportModal
          isOpen={qb.exportModalOpen}
          onClose={() => qb.setExportModalOpen(false)}
          questions={qb.questions}
          selectedIds={qb.selectedQuestions}
          filterParams={{
            page: qb.currentPage, pageSize: qb.pageSize,
            search: qb.searchTerm || undefined,
            difficulty: qb.selectedDifficulty || undefined,
            type: qb.selectedType || undefined,
            status: qb.selectedStatus || undefined,
          }}
          total={qb.total}
        />
      </div>
    </MainLayout>
  );
};
