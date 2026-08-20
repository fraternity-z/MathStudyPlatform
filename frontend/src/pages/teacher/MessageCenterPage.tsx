import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { RequestErrorNotice } from '@/components/feedback';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Tabs, TabsContent, TabsList } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import {
  Bell,
  Archive,
  ArrowLeft,
  Check,
  HelpCircle,
  Loader2,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  Plus,
  Search,
  SquareCheckBig,
  Users,
  UserRound,
  X,
} from 'lucide-react';
import { cn } from '@/libs/utils/cn';
import { toAppError, type AppError } from '@/libs/http/apiClient';
import { formatRelativeTime } from '@/libs/utils/dateFormat';
import { useSerialPolling } from '@/hooks/useSerialPolling';
import { classService } from '@/modules/classroom/services/classService';
import {
  conversationService,
  type ConversationDetail,
  type Contact,
} from '@/modules/message-center/services/conversationService';
import {
  noticeService,
  type TeacherNoticeItem,
  type TeacherNoticeListItem,
} from '@/modules/message-center/services/noticeService';
import {
  qaThreadService,
  type TeacherThreadItem,
  type ThreadDetail,
} from '@/modules/message-center/services/qaThreadService';
import {
  refreshMessageCenterSummaryAfterMutation,
  useMessageCenterSummary,
} from '@/modules/message-center/components/useMessageCenterSummary';
import {
  useObservedVisibility,
  usePageVisibility,
} from '@/modules/message-center/components/useObservedVisibility';
import {
  fetchLoadedPageRange,
  fetchCompleteOffsetMessageHistory,
  fetchStableOffsetMessageWindow,
  hasMinimumGlobalSearchCharacters,
  latestPageChanged,
  mergeByID,
  mergeLatestPageByID,
  mergeMessagesByID,
  matchesAllKeywords,
} from '@/modules/message-center/pageUtils';
import { MessageCenterSideTab } from '@/modules/message-center/MessageCenterSideTab';
import { MessageCenterFilterMenu } from '@/modules/message-center/MessageCenterFilterMenu';
import { MessageAttachmentPicker } from '@/modules/message-center/MessageAttachmentPicker';
import { MessageAttachments } from '@/modules/message-center/MessageAttachments';
import { MessageComposer } from '@/modules/message-center/MessageComposer';
import type { MessageAttachment } from '@/modules/message-center/attachmentTypes';
import { ForumCenter } from '@/modules/forum';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const noticeStatuses = ['全部', '有未确认', '全部确认'];
const answerStatuses = ['全部', '待回复', '已回复', '已解决', '需跟进'];
const listPageSize = 50;

interface ListLoadOptions {
  refreshLoadedPages?: boolean;
  signal?: AbortSignal;
}

type ListLoadResult = AppError | null;

function visibleAppError(error: unknown, fallback: string): AppError | null {
  const appError = toAppError(error, fallback);
  return appError.kind === 'cancelled' ? null : appError;
}

function visibleApiErrorMessage(error: unknown, fallback: string): string | null {
  const appError = visibleAppError(error, fallback);
  if (!appError || appError.kind === 'rate_limited') return null;
  return [
    appError.message,
    appError.retryAfter !== undefined && appError.retryAfter > 0
      ? `可在 ${appError.retryAfter} 秒后重试`
      : '',
    appError.requestId ? `请求编号：${appError.requestId}` : '',
  ].filter(Boolean).join('；');
}

type ConversationScrollIntent =
  | { type: 'bottom'; conversationID: string }
  | { type: 'preserve'; conversationID: string; scrollHeight: number; scrollTop: number };

function isConversationViewportNearBottom(viewport: HTMLDivElement): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 80;
}

const threadStatusVariant: Record<string, 'warning' | 'default' | 'success' | 'secondary'> = {
  '待回复': 'warning',
  '已回复': 'default',
  '已解决': 'success',
  '需跟进': 'secondary',
};

const teacherTabs = new Set(['private', 'notices', 'answers', 'forum']);

function parseTeacherTab(value: string | null): string {
  return value && teacherTabs.has(value) ? value : 'private';
}

interface ConvItem {
  id: string;
  studentName: string;
  className: string;
  lastMessage: string;
  lastTime: string;
  unread: boolean;
  pendingReply: boolean;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export const MessageCenterPage: React.FC = () => {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = parseTeacherTab(searchParams.get('tab'));
  const initialItemID = searchParams.get('id') ?? '';
  const conversationRequest = useRef(0);
  const noticeRequest = useRef(0);
  const threadRequest = useRef(0);
  const conversationListRequest = useRef(0);
  const noticeListRequest = useRef(0);
  const threadListRequest = useRef(0);
  const reloadRequest = useRef(0);
  const initialLoadStarted = useRef(false);
  const lastListQuery = useRef(`${initialTab}\u0000\u0000全部\u0000全部\u0000全部`);
  const handledLocationKey = useRef(location.key);
  const pendingDeepLink = useRef(initialItemID ? { tab: initialTab, id: initialItemID } : null);
  const contactSearchRequest = useRef(0);
  const threadStatusUpdateRef = useRef('');
  const acknowledgedConversationCutoff = useRef('');
  const acknowledgingConversationCutoff = useRef('');
  const acknowledgedThreadCutoff = useRef('');
  const acknowledgingThreadCutoff = useRef('');
  const { toast } = useToast();
  const notifyRequestError = useCallback((error: unknown, fallback: string) => {
    const appError = toAppError(error, fallback);
    if (appError.kind === 'cancelled' || appError.kind === 'rate_limited') return;
    const details = [
      appError.retryAfter !== undefined && appError.retryAfter > 0
        ? `可在 ${appError.retryAfter} 秒后重试`
        : '',
      appError.requestId ? `请求编号：${appError.requestId}` : '',
    ].filter(Boolean);
    toast({
      type: 'error',
      title: appError.message,
      description: details.length > 0 ? details.join('；') : undefined,
    });
  }, [toast]);
  const {
    summary,
    error: summaryError,
    isRefreshing: summaryRefreshing,
    refresh: refreshSummary,
  } = useMessageCenterSummary();
  const pageVisible = usePageVisibility();
  const { ref: conversationDetailRef, isVisible: conversationDetailVisible } = useObservedVisibility<HTMLDivElement>();
  const { ref: threadDetailRef, isVisible: threadDetailVisible } = useObservedVisibility<HTMLDivElement>();
  // ---- state ---------------------------------------------------------
  const [searchTerm, setSearchTerm] = useState('');
  const [serverSearch, setServerSearch] = useState('');
  const [activeTab, setActiveTab] = useState(initialTab);
  const [initialLoad, setInitialLoad] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<AppError | null>(null);

  // conversations
  const [convItems, setConvItems] = useState<ConvItem[]>([]);
  const [activeConv, setActiveConv] = useState<ConversationDetail | null>(null);
  const [activeConvId, setActiveConvId] = useState(initialTab === 'private' ? initialItemID : '');
  const activeConvIDRef = useRef(activeConvId);
  const conversationListModeRef = useRef(!activeConvId);
  const conversationDetailLoadingRef = useRef(Boolean(activeConvId));
  const [conversationDetailLoading, setConversationDetailLoading] = useState(Boolean(activeConvId));
  const [conversationDetailError, setConversationDetailError] = useState<AppError | null>(null);
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const messageDraft = activeConvId ? messageDrafts[activeConvId] ?? '' : '';
  const [messageAttachmentDrafts, setMessageAttachmentDrafts] = useState<Record<string, MessageAttachment[]>>({});
  const messageAttachments = useMemo(
    () => activeConvId ? messageAttachmentDrafts[activeConvId] ?? [] : [],
    [activeConvId, messageAttachmentDrafts],
  );
  const [messageUploading, setMessageUploading] = useState(false);
  const [sendingMsg, setSendingMsg] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const loadingOlderMessagesRef = useRef(false);
  const conversationViewportRef = useRef<HTMLDivElement>(null);
  const conversationScrollIntentRef = useRef<ConversationScrollIntent | null>(
    activeConvId ? { type: 'bottom', conversationID: activeConvId } : null,
  );
  const conversationSearchLoadingRef = useRef(false);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationMessageSearch, setConversationMessageSearch] = useState('');
  const [loadingConversationSearch, setLoadingConversationSearch] = useState(false);
  const [conversationSearchError, setConversationSearchError] = useState('');
  const [conversationPage, setConversationPage] = useState(1);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [conversationSelectionMode, setConversationSelectionMode] = useState(false);
  const [selectedConversationIds, setSelectedConversationIds] = useState<string[]>([]);
  const [archivingConversations, setArchivingConversations] = useState(false);

  // new conversation
  const [studentContacts, setStudentContacts] = useState<Contact[]>([]);
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<Contact[]>([]);
  const [newConvDraft, setNewConvDraft] = useState('');
  const [newConvAttachments, setNewConvAttachments] = useState<MessageAttachment[]>([]);
  const [newConvUploading, setNewConvUploading] = useState(false);
  const [creatingConv, setCreatingConv] = useState(false);

  // notices
  const [notices, setNotices] = useState<TeacherNoticeListItem[]>([]);
  const [activeNotice, setActiveNotice] = useState<TeacherNoticeItem | null>(null);
  const [activeNoticeId, setActiveNoticeId] = useState(initialTab === 'notices' ? initialItemID : '');
  const activeNoticeIDRef = useRef(activeNoticeId);
  const noticeDetailLoadingRef = useRef(Boolean(activeNoticeId));
  const [noticeDetailLoading, setNoticeDetailLoading] = useState(false);
  const [noticeDetailError, setNoticeDetailError] = useState<AppError | null>(null);
  const [noticeStatus, setNoticeStatus] = useState('全部');
  const [noticeModalOpen, setNoticeModalOpen] = useState(false);
  const [noticeTitle, setNoticeTitle] = useState('');
  const [noticeBody, setNoticeBody] = useState('');
  const [noticeAttachments, setNoticeAttachments] = useState<MessageAttachment[]>([]);
  const [noticeUploading, setNoticeUploading] = useState(false);
  const [noticeClassID, setNoticeClassID] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [noticePage, setNoticePage] = useState(1);
  const [noticeTotal, setNoticeTotal] = useState(0);
  const [remindingNoticeID, setRemindingNoticeID] = useState('');

  // threads
  const [threads, setThreads] = useState<TeacherThreadItem[]>([]);
  const [activeThread, setActiveThread] = useState<ThreadDetail | null>(null);
  const [activeThreadId, setActiveThreadId] = useState(initialTab === 'answers' ? initialItemID : '');
  const activeThreadIDRef = useRef(activeThreadId);
  const threadDetailLoadingRef = useRef(Boolean(activeThreadId));
  const [threadDetailLoading, setThreadDetailLoading] = useState(Boolean(activeThreadId));
  const [threadDetailError, setThreadDetailError] = useState<AppError | null>(null);
  const [answerStatus, setAnswerStatus] = useState('全部');
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const answerDraft = activeThreadId ? answerDrafts[activeThreadId] ?? '' : '';
  const [answerAttachmentDrafts, setAnswerAttachmentDrafts] = useState<Record<string, MessageAttachment[]>>({});
  const answerAttachments = useMemo(
    () => activeThreadId ? answerAttachmentDrafts[activeThreadId] ?? [] : [],
    [activeThreadId, answerAttachmentDrafts],
  );
  const [answerUploading, setAnswerUploading] = useState(false);
  const [sendingAnswer, setSendingAnswer] = useState(false);
  const [updatingThreadStatusId, setUpdatingThreadStatusId] = useState('');
  const [loadingOlderThreadMessages, setLoadingOlderThreadMessages] = useState(false);
  const loadingOlderThreadMessagesRef = useRef(false);
  const [threadPage, setThreadPage] = useState(1);
  const [threadTotal, setThreadTotal] = useState(0);
  const [loadingMoreList, setLoadingMoreList] = useState('');
  const loadingMoreListRef = useRef(false);
  const [listLoadError, setListLoadError] = useState<AppError | null>(null);
  const convItemsRef = useRef(convItems);
  const noticesRef = useRef(notices);
  const threadsRef = useRef(threads);
  const conversationTotalRef = useRef(conversationTotal);
  const noticeTotalRef = useRef(noticeTotal);
  const threadTotalRef = useRef(threadTotal);
  const conversationQueryRef = useRef(serverSearch);
  const noticeQueryRef = useRef(`${serverSearch}\u0000${noticeStatus}`);
  const threadQueryRef = useRef(`${serverSearch}\u0000${answerStatus}`);
  conversationQueryRef.current = serverSearch;
  noticeQueryRef.current = `${serverSearch}\u0000${noticeStatus}`;
  threadQueryRef.current = `${serverSearch}\u0000${answerStatus}`;
  convItemsRef.current = convItems;
  noticesRef.current = notices;
  threadsRef.current = threads;
  conversationTotalRef.current = conversationTotal;
  noticeTotalRef.current = noticeTotal;
  threadTotalRef.current = threadTotal;
  const tabCounts = {
    private: summary?.conversation_count ?? 0,
    notices: summary?.notice_count ?? 0,
    answers: summary?.thread_count ?? 0,
    forum: summary?.forum_count ?? 0,
  };

  const [noticeClasses, setNoticeClasses] = useState<Array<{ id: string; name: string }>>([]);

  const resetNewConversationForm = useCallback(() => {
    contactSearchRequest.current++;
    setSelectedStudentId('');
    setContactSearch('');
    setGlobalSearchResults([]);
    setNewConvDraft('');
	setNewConvAttachments([]);
  }, []);

  const closeNewConversationModal = useCallback(() => {
    setNewConvOpen(false);
    resetNewConversationForm();
  }, [resetNewConversationForm]);

  const consumePendingDeepLink = useCallback((tab: string): string => {
    const pending = pendingDeepLink.current;
    if (!pending || pending.tab !== tab) return '';
    pendingDeepLink.current = null;
    return pending.id;
  }, []);

  const activateConversation = useCallback((id: string): boolean => {
    conversationListModeRef.current = !id;
    conversationScrollIntentRef.current = id ? { type: 'bottom', conversationID: id } : null;
    if (activeConvIDRef.current === id) return false;
    activeConvIDRef.current = id;
    conversationRequest.current++;
    loadingOlderMessagesRef.current = false;
    conversationSearchLoadingRef.current = false;
    setActiveConvId(id);
    setActiveConv(null);
    setLoadingOlderMessages(false);
    setConversationSearchOpen(false);
    setConversationMessageSearch('');
    setLoadingConversationSearch(false);
    setConversationSearchError('');
    conversationDetailLoadingRef.current = Boolean(id);
    setConversationDetailLoading(Boolean(id));
    setConversationDetailError(null);
    return true;
  }, []);

  const activateThread = useCallback((id: string): boolean => {
    if (activeThreadIDRef.current === id) return false;
    activeThreadIDRef.current = id;
    threadRequest.current++;
    loadingOlderThreadMessagesRef.current = false;
    setActiveThreadId(id);
    setActiveThread(null);
    setLoadingOlderThreadMessages(false);
    threadDetailLoadingRef.current = Boolean(id);
    setThreadDetailLoading(Boolean(id));
    setThreadDetailError(null);
    return true;
  }, []);

  const activateNotice = useCallback((id: string): boolean => {
    if (activeNoticeIDRef.current === id) return false;
    activeNoticeIDRef.current = id;
    noticeRequest.current++;
    setActiveNoticeId(id);
    setActiveNotice(null);
    noticeDetailLoadingRef.current = Boolean(id);
    setNoticeDetailLoading(Boolean(id));
    setNoticeDetailError(null);
    return true;
  }, []);

  const clearItemDeepLink = useCallback((tab: string) => {
    pendingDeepLink.current = null;
    if (!searchParams.has('id')) return;
    setSearchParams({ tab }, { replace: true });
  }, [searchParams, setSearchParams]);

  const showConversationList = useCallback(() => {
    conversationListModeRef.current = true;
    clearItemDeepLink('private');
    activateConversation('');
  }, [activateConversation, clearItemDeepLink]);

  useEffect(() => {
    const timer = window.setTimeout(() => setServerSearch(searchTerm.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    setConversationSelectionMode(false);
    setSelectedConversationIds([]);
  }, [serverSearch]);

  useEffect(() => {
    setSelectedConversationIds((current) => current.filter((id) => convItems.some((conversation) => conversation.id === id)));
  }, [convItems]);

  // load real class names from class service on mount
  useEffect(() => {
    const controller = new AbortController();
    classService.listTeacherClasses(controller.signal).then((res) => {
      if (!controller.signal.aborted && res.items?.length > 0) {
        const classes = res.items.map((c) => ({ id: c.id, name: c.name }));
        setNoticeClasses(classes);
        setNoticeClassID(classes[0].id);
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      notifyRequestError(error, '班级列表加载失败，暂不能发布通知');
    });
    return () => controller.abort();
  }, [notifyRequestError]);

  // ---- load data ------------------------------------------------------
  const loadConversations = useCallback(async (page = 1, append = false, preserveLoadedPages = false, options: ListLoadOptions = {}): Promise<ListLoadResult> => {
    const queryKey = serverSearch;
    if (queryKey !== conversationQueryRef.current) return null;
    const request = ++conversationListRequest.current;
    try {
      let response = options.refreshLoadedPages
        ? await fetchLoadedPageRange(conversationPage, listPageSize, (loadedPage) => conversationService.list({ search: serverSearch, page: loadedPage, page_size: listPageSize }, options.signal))
        : await conversationService.list({ search: serverSearch, page, page_size: listPageSize }, options.signal);
      if (options.signal?.aborted || request !== conversationListRequest.current || queryKey !== conversationQueryRef.current) return null;
      const refreshShiftedWindow = !options.refreshLoadedPages
        && preserveLoadedPages
        && conversationPage > 1
        && latestPageChanged(convItemsRef.current, response.items, conversationTotalRef.current, response.total);
      if (refreshShiftedWindow) {
        response = await fetchLoadedPageRange(conversationPage, listPageSize, (loadedPage) => conversationService.list({ search: serverSearch, page: loadedPage, page_size: listPageSize }, options.signal));
        if (options.signal?.aborted || request !== conversationListRequest.current || queryKey !== conversationQueryRef.current) return null;
      }
      const replaceLoadedPages = options.refreshLoadedPages || refreshShiftedWindow;
      const items = response.items.map((c) => ({
        id: c.id,
        studentName: c.student_name ?? '',
        className: c.class_name ?? '',
        lastMessage: c.last_message,
        lastTime: formatRelativeTime(c.last_time),
        unread: c.unread > 0,
        pendingReply: c.pending_reply ?? false,
      }));
      setConvItems((current) => append
        ? mergeByID(current, items)
        : preserveLoadedPages && !replaceLoadedPages
          ? mergeLatestPageByID(current, items, response.total)
          : items);
      if (replaceLoadedPages) {
        setConversationPage(Math.max(1, Math.min(conversationPage, Math.ceil(response.total / listPageSize) || 1)));
      } else if (!preserveLoadedPages) {
        setConversationPage(page);
      }
      setConversationTotal(response.total);
      if (!append) {
        const deepLinkID = consumePendingDeepLink('private');
        if (deepLinkID) activateConversation(deepLinkID);
        else if (conversationListModeRef.current && activeConvIDRef.current) activateConversation('');
      }
      return null;
    } catch (error) {
      if (options.signal?.aborted || request !== conversationListRequest.current || queryKey !== conversationQueryRef.current) return null;
      return visibleAppError(error, '私信列表加载失败，请稍后重试');
    }
  }, [activateConversation, consumePendingDeepLink, conversationPage, serverSearch]);

  const loadConvDetail = useCallback(async (id: string, preserveLoadedMessages = false) => {
    const request = ++conversationRequest.current;
    conversationDetailLoadingRef.current = true;
    if (!preserveLoadedMessages) {
      conversationScrollIntentRef.current = { type: 'bottom', conversationID: id };
      setConversationDetailLoading(true);
    }
    setConversationDetailError(null);
    try {
      const d = await conversationService.get(id);
      if (request === conversationRequest.current && activeConvIDRef.current === id) {
        setActiveConv((current) => preserveLoadedMessages && current?.id === d.id ? {
          ...d,
          messages: mergeMessagesByID(current.messages, d.messages),
          messages_page: current.messages_page,
          messages_page_size: current.messages_page_size,
        } : d);
        conversationDetailLoadingRef.current = false;
        setConversationDetailLoading(false);
      }
      return true;
    } catch (error) {
      if (request === conversationRequest.current && activeConvIDRef.current === id) {
        if (!preserveLoadedMessages) {
          setActiveConv(null);
          setConversationDetailError(visibleAppError(error, '私信详情加载失败，请稍后重试'));
        }
        conversationDetailLoadingRef.current = false;
        setConversationDetailLoading(false);
      }
      return false;
    }
  }, []);

  const loadStudentContacts = useCallback(async () => {
    try {
      const { contacts: list } = await conversationService.studentContacts();
      setStudentContacts(list);
      setSelectedStudentId((current) => list.some((contact) => contact.id === current) ? current : '');
      return true;
    } catch { return false; }
  }, []);

  const filteredStudentContacts = useMemo(
    () => {
      if (!contactSearch.trim()) return studentContacts;
      const kw = contactSearch.trim().toLowerCase();
      return studentContacts.filter((c) =>
        c.id.toLowerCase().includes(kw) ||
        c.display_name.toLowerCase().includes(kw) ||
        c.scope.toLowerCase().includes(kw),
      );
    },
    [studentContacts, contactSearch],
  );

  useEffect(() => {
    const request = ++contactSearchRequest.current;
    const q = contactSearch.trim();
    if (!hasMinimumGlobalSearchCharacters(q)) { setGlobalSearchResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const { contacts: list } = await conversationService.searchUsers(q);
        if (request === contactSearchRequest.current) {
          setGlobalSearchResults(list.filter((c) => !studentContacts.some((s) => s.id === c.id)));
        }
      } catch {
        if (request === contactSearchRequest.current) setGlobalSearchResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [contactSearch, studentContacts]);

  const allStudentSearchResults = useMemo(() => {
    const local = filteredStudentContacts;
    const extra = globalSearchResults.filter((g) => !local.some((l) => l.id === g.id));
    return [...local, ...extra];
  }, [filteredStudentContacts, globalSearchResults]);

  const createConversation = useCallback(async () => {
    if (!selectedStudentId || creatingConv) return;
    conversationListRequest.current++;
    setCreatingConv(true);
    try {
      const student = studentContacts.find((s) => s.id === selectedStudentId);
      const detail = await conversationService.create({
        target_id: selectedStudentId,
        subject: student?.scope ?? '',
        initial_message: newConvDraft.trim(),
		attachments: newConvAttachments,
      });
      closeNewConversationModal();
      await loadConversations();
      activateConversation(detail.id);
      refreshMessageCenterSummaryAfterMutation();
    } catch (error) {
      notifyRequestError(error, '创建私信失败，请稍后重试');
    }
    finally { setCreatingConv(false); }
  }, [activateConversation, closeNewConversationModal, selectedStudentId, studentContacts, newConvDraft, newConvAttachments, creatingConv, loadConversations, notifyRequestError]);

  const loadNoticeDetail = useCallback(async (id: string): Promise<boolean> => {
    const request = ++noticeRequest.current;
    noticeDetailLoadingRef.current = true;
    setNoticeDetailLoading(true);
    setNoticeDetailError(null);
    try {
      const detail = await noticeService.get(id);
      if (!('confirmed_count' in detail)) throw new Error('unexpected student notice detail');
      if (request === noticeRequest.current && activeNoticeIDRef.current === id) {
        setActiveNotice(detail);
        noticeDetailLoadingRef.current = false;
        setNoticeDetailLoading(false);
      }
      return true;
    } catch (error) {
      if (request === noticeRequest.current && activeNoticeIDRef.current === id) {
        setActiveNotice(null);
        setNoticeDetailError(visibleAppError(error, '通知详情加载失败，请稍后重试'));
        noticeDetailLoadingRef.current = false;
        setNoticeDetailLoading(false);
      }
      return false;
    }
  }, []);

  const loadNotices = useCallback(async (page = 1, append = false, preserveLoadedPages = false, options: ListLoadOptions = {}): Promise<ListLoadResult> => {
    const queryKey = `${serverSearch}\u0000${noticeStatus}`;
    if (queryKey !== noticeQueryRef.current) return null;
    const request = ++noticeListRequest.current;
    try {
      const status = noticeStatus === '全部' ? '' : noticeStatus === '有未确认' ? '有未确认' : '全部确认';
      let response = options.refreshLoadedPages
        ? await fetchLoadedPageRange(noticePage, listPageSize, (loadedPage) => noticeService.list<TeacherNoticeListItem>({ search: serverSearch, status, page: loadedPage, page_size: listPageSize }, options.signal))
        : await noticeService.list<TeacherNoticeListItem>({ search: serverSearch, status, page, page_size: listPageSize }, options.signal);
      if (options.signal?.aborted || request !== noticeListRequest.current || queryKey !== noticeQueryRef.current) return null;
      const refreshShiftedWindow = !options.refreshLoadedPages
        && preserveLoadedPages
        && noticePage > 1
        && latestPageChanged(noticesRef.current, response.items, noticeTotalRef.current, response.total);
      if (refreshShiftedWindow) {
        response = await fetchLoadedPageRange(noticePage, listPageSize, (loadedPage) => noticeService.list<TeacherNoticeListItem>({ search: serverSearch, status, page: loadedPage, page_size: listPageSize }, options.signal));
        if (options.signal?.aborted || request !== noticeListRequest.current || queryKey !== noticeQueryRef.current) return null;
      }
      const replaceLoadedPages = options.refreshLoadedPages || refreshShiftedWindow;
      const items = response.items;
      setNotices((current) => append
        ? mergeByID(current, items)
        : preserveLoadedPages && !replaceLoadedPages
          ? mergeLatestPageByID(current, items, response.total)
          : items);
      if (replaceLoadedPages) {
        setNoticePage(Math.max(1, Math.min(noticePage, Math.ceil(response.total / listPageSize) || 1)));
      } else if (!preserveLoadedPages) {
        setNoticePage(page);
      }
      setNoticeTotal(response.total);
      if (!append) {
        const deepLinkID = consumePendingDeepLink('notices');
        if (deepLinkID) activateNotice(deepLinkID);
      }
      return null;
    } catch (error) {
      if (options.signal?.aborted || request !== noticeListRequest.current || queryKey !== noticeQueryRef.current) return null;
      return visibleAppError(error, '通知列表加载失败，请稍后重试');
    }
  }, [activateNotice, consumePendingDeepLink, noticePage, serverSearch, noticeStatus]);

  const loadThreads = useCallback(async (page = 1, append = false, preserveLoadedPages = false, options: ListLoadOptions = {}): Promise<ListLoadResult> => {
    const queryKey = `${serverSearch}\u0000${answerStatus}`;
    if (queryKey !== threadQueryRef.current) return null;
    const request = ++threadListRequest.current;
    try {
      const status = answerStatus === '全部' ? '' : answerStatus;
      let response = options.refreshLoadedPages
        ? await fetchLoadedPageRange(threadPage, listPageSize, (loadedPage) => qaThreadService.list<TeacherThreadItem>({ search: serverSearch, status, page: loadedPage, page_size: listPageSize }, options.signal))
        : await qaThreadService.list<TeacherThreadItem>({ search: serverSearch, status, page, page_size: listPageSize }, options.signal);
      if (options.signal?.aborted || request !== threadListRequest.current || queryKey !== threadQueryRef.current) return null;
      const refreshShiftedWindow = !options.refreshLoadedPages
        && preserveLoadedPages
        && threadPage > 1
        && latestPageChanged(threadsRef.current, response.items, threadTotalRef.current, response.total);
      if (refreshShiftedWindow) {
        response = await fetchLoadedPageRange(threadPage, listPageSize, (loadedPage) => qaThreadService.list<TeacherThreadItem>({ search: serverSearch, status, page: loadedPage, page_size: listPageSize }, options.signal));
        if (options.signal?.aborted || request !== threadListRequest.current || queryKey !== threadQueryRef.current) return null;
      }
      const replaceLoadedPages = options.refreshLoadedPages || refreshShiftedWindow;
      const items = response.items;
      setThreads((current) => append
        ? mergeByID(current, items)
        : preserveLoadedPages && !replaceLoadedPages
          ? mergeLatestPageByID(current, items, response.total)
          : items);
      if (replaceLoadedPages) {
        setThreadPage(Math.max(1, Math.min(threadPage, Math.ceil(response.total / listPageSize) || 1)));
      } else if (!preserveLoadedPages) {
        setThreadPage(page);
      }
      setThreadTotal(response.total);
      if (!append) {
        const deepLinkID = consumePendingDeepLink('answers');
        if (deepLinkID) activateThread(deepLinkID);
      }
      return null;
    } catch (error) {
      if (options.signal?.aborted || request !== threadListRequest.current || queryKey !== threadQueryRef.current) return null;
      return visibleAppError(error, '答疑列表加载失败，请稍后重试');
    }
  }, [activateThread, answerStatus, consumePendingDeepLink, serverSearch, threadPage]);

	const loadThreadDetail = useCallback(async (id: string, preserveLoadedMessages = false): Promise<boolean> => {
				const request = ++threadRequest.current;
				threadDetailLoadingRef.current = true;
				setThreadDetailLoading(true);
				setThreadDetailError(null);
				try {
					const d = await qaThreadService.get(id);
					if (request === threadRequest.current && activeThreadIDRef.current === id) {
						setActiveThread((current) => preserveLoadedMessages && current?.id === d.id ? {
							...d,
							messages: mergeMessagesByID(current.messages, d.messages),
							messages_page: current.messages_page,
							messages_page_size: current.messages_page_size,
						} : d);
						threadDetailLoadingRef.current = false;
						setThreadDetailLoading(false);
					}
      return true;
    } catch (error) {
      if (request === threadRequest.current && activeThreadIDRef.current === id) {
        setActiveThread(null);
        setThreadDetailError(visibleAppError(error, '答疑详情加载失败，请稍后重试'));
        threadDetailLoadingRef.current = false;
        setThreadDetailLoading(false);
      }
      return false;
    }
  }, []);

  useEffect(() => {
    if (activeTab !== 'private') {
      conversationRequest.current++;
      conversationDetailLoadingRef.current = false;
      setConversationDetailLoading(false);
      return;
    }
    if (!activeConvId) {
      conversationRequest.current++;
      setActiveConv(null);
      conversationDetailLoadingRef.current = false;
      setConversationDetailLoading(false);
      setConversationDetailError(null);
      return;
    }
    setActiveConv(null);
    void loadConvDetail(activeConvId);
  }, [activeConvId, activeTab, loadConvDetail]);

  useLayoutEffect(() => {
    const viewport = conversationViewportRef.current;
    const intent = conversationScrollIntentRef.current;
    if (!viewport || !intent || !activeConv || activeConv.id !== activeConvId || intent.conversationID !== activeConv.id) return;

    if (intent.type === 'bottom') {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      viewport.scrollTop = Math.max(0, intent.scrollTop + viewport.scrollHeight - intent.scrollHeight);
    }
    if (conversationScrollIntentRef.current === intent) conversationScrollIntentRef.current = null;
  }, [activeConv, activeConvId]);

  useEffect(() => {
    const throughMessageID = activeConv?.read_through_message_id;
    const cutoffKey = activeConv && throughMessageID ? `${activeConv.id}:${throughMessageID}` : '';
    if (!pageVisible || !conversationDetailVisible || activeTab !== 'private' || !activeConv || !throughMessageID || activeConv.id !== activeConvId || acknowledgedConversationCutoff.current === cutoffKey || acknowledgingConversationCutoff.current === cutoffKey) return;
    const conversationID = activeConv.id;
    const controller = new AbortController();
    acknowledgingConversationCutoff.current = cutoffKey;
    conversationListRequest.current++;
    void conversationService.acknowledgeRead(conversationID, throughMessageID, controller.signal).then(async () => {
      acknowledgedConversationCutoff.current = cutoffKey;
      const listError = await loadConversations(1, false, false, { refreshLoadedPages: true });
      if (listError) setListLoadError(listError);
      refreshMessageCenterSummaryAfterMutation();
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      notifyRequestError(error, '私信已显示，但同步已读状态失败');
    }).finally(() => {
      if (acknowledgingConversationCutoff.current === cutoffKey) acknowledgingConversationCutoff.current = '';
    });
    return () => controller.abort();
  }, [activeConv, activeConvId, activeTab, conversationDetailVisible, loadConversations, notifyRequestError, pageVisible]);

  useEffect(() => {
    if (activeTab !== 'answers') {
      threadRequest.current++;
      threadDetailLoadingRef.current = false;
      setThreadDetailLoading(false);
      return;
    }
    if (!activeThreadId) {
      threadRequest.current++;
      setActiveThread(null);
      threadDetailLoadingRef.current = false;
      setThreadDetailLoading(false);
      setThreadDetailError(null);
      return;
    }
    setActiveThread(null);
    void loadThreadDetail(activeThreadId);
  }, [activeTab, activeThreadId, loadThreadDetail]);

  useEffect(() => {
    const throughMessageID = activeThread?.read_through_message_id;
    const cutoffKey = activeThread && throughMessageID ? `${activeThread.id}:${throughMessageID}` : '';
    if (!pageVisible || !threadDetailVisible || activeTab !== 'answers' || !activeThread || !throughMessageID || activeThread.id !== activeThreadId || acknowledgedThreadCutoff.current === cutoffKey || acknowledgingThreadCutoff.current === cutoffKey) return;
    const threadID = activeThread.id;
    const controller = new AbortController();
    acknowledgingThreadCutoff.current = cutoffKey;
    threadListRequest.current++;
    void qaThreadService.acknowledgeRead(threadID, throughMessageID, controller.signal).then(async () => {
      acknowledgedThreadCutoff.current = cutoffKey;
      const listError = await loadThreads(1, false, false, { refreshLoadedPages: true });
      if (listError) setListLoadError(listError);
      refreshMessageCenterSummaryAfterMutation();
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      notifyRequestError(error, '答疑已显示，但同步已读状态失败');
    }).finally(() => {
      if (acknowledgingThreadCutoff.current === cutoffKey) acknowledgingThreadCutoff.current = '';
    });
    return () => controller.abort();
  }, [activeTab, activeThread, activeThreadId, loadThreads, notifyRequestError, pageVisible, threadDetailVisible]);

  const reloadInitialData = useCallback(async (preserveCurrent = false) => {
    const request = ++reloadRequest.current;
    setLoading(true);
    setLoadError(null);
    const refreshOptions: ListLoadOptions = preserveCurrent ? { refreshLoadedPages: true } : {};
    const results = await Promise.all([
      loadConversations(1, false, false, refreshOptions),
      loadNotices(1, false, false, refreshOptions),
      loadThreads(1, false, false, refreshOptions),
    ]);
    if (request !== reloadRequest.current) return;
    const firstError = results.find((result): result is AppError => result !== null) ?? null;
    setLoadError(firstError);
    if (!firstError) setListLoadError(null);
    setLoading(false);
    setInitialLoad(false);
  }, [loadConversations, loadNotices, loadThreads]);

  // initial load — only shows full-page spinner on first mount
  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void reloadInitialData();
  }, [reloadInitialData]);

  useEffect(() => {
    if (initialLoad) return;
    const queryKey = `${activeTab}\u0000${serverSearch}\u0000${noticeStatus}\u0000${answerStatus}`;
    if (lastListQuery.current === queryKey) return;
    lastListQuery.current = queryKey;
    let active = true;
    const load = async () => {
      const results = await Promise.all([
        loadConversations(),
        loadNotices(),
        loadThreads(),
      ]);
      const firstError = results.find((result): result is AppError => result !== null) ?? null;
      if (active) setListLoadError(firstError);
    };
    void load();
    return () => { active = false; };
  }, [activeTab, answerStatus, initialLoad, loadConversations, loadNotices, loadThreads, noticeStatus, serverSearch]);

  const pollMessageCenter = useCallback(async (signal: AbortSignal) => {
    if (signal.aborted || initialLoad || document.hidden || loadingMoreListRef.current || loadingOlderMessagesRef.current || conversationSearchLoadingRef.current || loadingOlderThreadMessagesRef.current || conversationDetailLoadingRef.current || noticeDetailLoadingRef.current || threadDetailLoadingRef.current || threadStatusUpdateRef.current) return;
    await Promise.all([
      loadConversations(1, false, true, { signal }),
      loadNotices(1, false, true, { signal }),
      loadThreads(1, false, true, { signal }),
    ]);
    if (signal.aborted || noticeDetailLoadingRef.current) return;
    if (document.hidden || loadingMoreListRef.current || loadingOlderMessagesRef.current || conversationSearchLoadingRef.current || loadingOlderThreadMessagesRef.current || conversationDetailLoadingRef.current || threadDetailLoadingRef.current || threadStatusUpdateRef.current) return;
    const currentConversationID = activeConvIDRef.current;
    const currentNoticeID = activeNoticeIDRef.current;
    const currentThreadID = activeThreadIDRef.current;
    if (activeTab === 'private' && currentConversationID) {
      const request = ++conversationRequest.current;
      try {
        const detail = await conversationService.get(currentConversationID, undefined, signal);
        if (signal.aborted || document.hidden || request !== conversationRequest.current || activeConvIDRef.current !== currentConversationID) return;
        const viewport = conversationViewportRef.current;
        if (!conversationSearchOpen && viewport && isConversationViewportNearBottom(viewport)) {
          conversationScrollIntentRef.current = { type: 'bottom', conversationID: currentConversationID };
        }
        setActiveConv((current) => current?.id === detail.id ? {
          ...detail,
          messages: mergeMessagesByID(current.messages, detail.messages),
          messages_page: current.messages_page,
          messages_page_size: current.messages_page_size,
        } : current);
      } catch { /* retain the last successfully loaded detail */ }
    }
    if (activeTab === 'notices' && currentNoticeID) {
      const request = ++noticeRequest.current;
      try {
        const detail = await noticeService.get(currentNoticeID, signal);
        if (!('confirmed_count' in detail)) return;
        if (signal.aborted || document.hidden || request !== noticeRequest.current || activeNoticeIDRef.current !== currentNoticeID) return;
        setActiveNotice(detail);
        noticeDetailLoadingRef.current = false;
        setNoticeDetailLoading(false);
        setNoticeDetailError(null);
      } catch { /* retain the last successfully loaded detail */ }
    }
    if (activeTab === 'answers' && currentThreadID) {
      const request = ++threadRequest.current;
      try {
        const detail = await qaThreadService.get(currentThreadID, undefined, signal);
        if (signal.aborted || document.hidden || request !== threadRequest.current || activeThreadIDRef.current !== currentThreadID) return;
        setActiveThread((current) => current?.id === detail.id ? {
          ...detail,
          messages: mergeMessagesByID(current.messages, detail.messages),
          messages_page: current.messages_page,
          messages_page_size: current.messages_page_size,
        } : current);
      } catch { /* retain the last successfully loaded detail */ }
    }
  }, [activeTab, conversationSearchOpen, initialLoad, loadConversations, loadNotices, loadThreads]);

  useSerialPolling(pollMessageCenter, 30_000);

  // ---- derived --------------------------------------------------------
  // ---- actions: conversations -----------------------------------------
  const openConversation = useCallback((id: string) => {
    clearItemDeepLink('private');
    if (!activateConversation(id)) {
      setActiveConv(null);
      void loadConvDetail(id);
    }
  }, [activateConversation, clearItemDeepLink, loadConvDetail]);

  useEffect(() => {
    if (activeTab !== 'notices') {
      noticeRequest.current++;
      noticeDetailLoadingRef.current = false;
      setNoticeDetailLoading(false);
      return;
    }
    if (!activeNoticeId) {
      noticeRequest.current++;
      setActiveNotice(null);
      noticeDetailLoadingRef.current = false;
      setNoticeDetailLoading(false);
      setNoticeDetailError(null);
      return;
    }
    setActiveNotice(null);
    void loadNoticeDetail(activeNoticeId);
  }, [activeNoticeId, activeTab, loadNoticeDetail]);

  const sendPrivateMessage = useCallback(async (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (!activeConv || activeConv.id !== activeConvId || (!messageDraft.trim() && messageAttachments.length === 0) || sendingMsg || messageUploading) return;
    const conversationID = activeConv.id;
    const submittedDraft = messageDraft;
    const submittedAttachments = messageAttachments;
    conversationRequest.current++;
    conversationListRequest.current++;
    setSendingMsg(true);
    try {
      await conversationService.sendMessage(conversationID, submittedDraft.trim(), submittedAttachments);
      setMessageDrafts((current) => {
        if ((current[conversationID] ?? '') !== submittedDraft) return current;
        const next = { ...current };
        delete next[conversationID];
        return next;
      });
      setMessageAttachmentDrafts((current) => {
        if (current[conversationID] !== submittedAttachments) return current;
        const next = { ...current };
        delete next[conversationID];
        return next;
      });
      if (activeConvIDRef.current === conversationID) {
        conversationScrollIntentRef.current = { type: 'bottom', conversationID };
        const refreshed = await loadConvDetail(conversationID, true);
        if (!refreshed && conversationScrollIntentRef.current?.conversationID === conversationID) {
          conversationScrollIntentRef.current = null;
        }
      }
      await loadConversations(1, false, false, { refreshLoadedPages: true });
      refreshMessageCenterSummaryAfterMutation();
    } catch (error) {
      notifyRequestError(error, '发送私信失败，请稍后重试');
    }
    finally { setSendingMsg(false); }
  }, [activeConv, activeConvId, messageAttachments, messageDraft, messageUploading, sendingMsg, loadConvDetail, loadConversations, notifyRequestError]);

  const loadOlderConversationMessages = useCallback(async () => {
    if (!activeConv || activeConv.id !== activeConvIDRef.current || loadingOlderMessagesRef.current || conversationSearchLoadingRef.current || activeConv.messages.length >= activeConv.messages_total) return;
    const conversationID = activeConv.id;
    const request = ++conversationRequest.current;
    loadingOlderMessagesRef.current = true;
    setLoadingOlderMessages(true);
    try {
      const nextPage = activeConv.messages_page + 1;
      const detail = await conversationService.get(conversationID, { messages_page: nextPage, messages_page_size: activeConv.messages_page_size });
      if (request !== conversationRequest.current) return;
      let messages = mergeMessagesByID(activeConv.messages, detail.messages);
      let messagesTotal = detail.messages_total;
      const headDetail = await conversationService.get(conversationID, { messages_page: 1, messages_page_size: activeConv.messages_page_size });
      if (request !== conversationRequest.current) return;
      const currentHeadID = activeConv.messages.at(-1)?.id ?? '';
      const serverHeadID = headDetail.messages.at(-1)?.id ?? '';
      const headShifted = currentHeadID !== serverHeadID
        || activeConv.messages_total !== headDetail.messages_total
        || detail.messages_total !== headDetail.messages_total;
      const loadedWindowDrifted = activeConv.messages.length < headDetail.messages_total
        && activeConv.messages.length !== Math.min(
          headDetail.messages_total,
          activeConv.messages_page * activeConv.messages_page_size,
        );
      if (headShifted || loadedWindowDrifted || messages.length < Math.min(messagesTotal, nextPage * activeConv.messages_page_size)) {
        const stableWindow = await fetchStableOffsetMessageWindow(nextPage, activeConv.messages_page_size, async (messagesPage) => {
          const pageDetail = await conversationService.get(conversationID, { messages_page: messagesPage, messages_page_size: activeConv.messages_page_size });
          return { messages: pageDetail.messages, messages_total: pageDetail.messages_total };
        });
        if (request !== conversationRequest.current) return;
        messages = stableWindow.messages;
        messagesTotal = stableWindow.total;
      }
      const viewport = conversationViewportRef.current;
      if (viewport && activeConvIDRef.current === conversationID) {
        conversationScrollIntentRef.current = {
          type: 'preserve',
          conversationID,
          scrollHeight: viewport.scrollHeight,
          scrollTop: viewport.scrollTop,
        };
      }
      setActiveConv((current) => current?.id === detail.id ? {
        ...detail,
        read_through_message_id: current.read_through_message_id,
        messages,
        messages_total: messagesTotal,
        messages_page: nextPage,
      } : current);
    } catch (error) {
      if (request === conversationRequest.current && activeConvIDRef.current === conversationID) {
        notifyRequestError(error, '加载更早私信失败，请稍后重试');
      }
    } finally {
      if (activeConvIDRef.current === conversationID) {
        loadingOlderMessagesRef.current = false;
        setLoadingOlderMessages(false);
      }
    }
  }, [activeConv, notifyRequestError]);

  const toggleConversationSearch = useCallback(async () => {
    if (!activeConv || activeConv.id !== activeConvIDRef.current || conversationSearchLoadingRef.current) return;
    if (conversationSearchOpen) {
      setConversationSearchOpen(false);
      setConversationMessageSearch('');
      setConversationSearchError('');
      return;
    }

    const conversationID = activeConv.id;
    setConversationSearchOpen(true);
    setConversationMessageSearch('');
    setConversationSearchError('');
    if (activeConv.messages.length >= activeConv.messages_total) return;

    const request = ++conversationRequest.current;
    const pageSize = 100;
    conversationSearchLoadingRef.current = true;
    setLoadingConversationSearch(true);
    try {
      const history = await fetchCompleteOffsetMessageHistory(activeConv.messages_total, pageSize, async (messagesPage) => {
        const detail = await conversationService.get(conversationID, { messages_page: messagesPage, messages_page_size: pageSize });
        return { messages: detail.messages, messages_total: detail.messages_total };
      });
      if (request !== conversationRequest.current || activeConvIDRef.current !== conversationID) return;
      setActiveConv((current) => current?.id === conversationID ? {
        ...current,
        messages: history.messages,
        messages_total: history.total,
        messages_page: history.page,
        messages_page_size: pageSize,
      } : current);
    } catch (error) {
      if (request === conversationRequest.current && activeConvIDRef.current === conversationID) {
        const message = visibleApiErrorMessage(error, '完整聊天记录加载失败，当前仅搜索已加载的消息');
        if (message) setConversationSearchError(message);
      }
    } finally {
      if (activeConvIDRef.current === conversationID) {
        conversationSearchLoadingRef.current = false;
        setLoadingConversationSearch(false);
      }
    }
  }, [activeConv, conversationSearchOpen]);

  const loadMoreConversations = useCallback(async () => {
    if (loadingMoreListRef.current || convItems.length >= conversationTotal) return;
    loadingMoreListRef.current = true;
    setLoadingMoreList('conversations');
    try {
      const error = await loadConversations(conversationPage + 1, true);
      if (error) notifyRequestError(error, '加载更多私信失败，请稍后重试');
    } finally {
      loadingMoreListRef.current = false;
      setLoadingMoreList('');
    }
  }, [convItems.length, conversationTotal, loadConversations, conversationPage, notifyRequestError]);

  const archiveSelectedConversations = useCallback(async () => {
    if (archivingConversations || selectedConversationIds.length === 0) return;
    const requestedIDs = [...selectedConversationIds];
    setArchivingConversations(true);
    conversationListRequest.current++;
    try {
      const results = await Promise.allSettled(requestedIDs.map((id) => conversationService.archive(id)));
      const archivedIDs = new Set(requestedIDs.filter((_, index) => results[index].status === 'fulfilled'));
      const failedIDs = requestedIDs.filter((id) => !archivedIDs.has(id));

      if (archivedIDs.size > 0) {
        setMessageDrafts((current) => {
          const nextDrafts = { ...current };
          archivedIDs.forEach((id) => delete nextDrafts[id]);
          return nextDrafts;
        });
        setMessageAttachmentDrafts((current) => {
          const nextDrafts = { ...current };
          archivedIDs.forEach((id) => delete nextDrafts[id]);
          return nextDrafts;
        });
        clearItemDeepLink('private');
        if (archivedIDs.has(activeConvIDRef.current)) activateConversation('');
        await loadConversations();
        refreshMessageCenterSummaryAfterMutation();
      }

      if (failedIDs.length > 0) {
        setSelectedConversationIds(failedIDs);
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        notifyRequestError(
          failure?.reason,
          archivedIDs.size > 0 ? '部分私信归档失败，请重试' : '归档私信失败，请稍后重试',
        );
      } else {
        setSelectedConversationIds([]);
        setConversationSelectionMode(false);
      }
    } finally {
      setArchivingConversations(false);
    }
  }, [activateConversation, archivingConversations, clearItemDeepLink, loadConversations, notifyRequestError, selectedConversationIds]);

  // ---- actions: notices -----------------------------------------------
  const publishNotice = useCallback(async () => {
    if (!noticeClassID) {
      toast({ type: 'error', title: '请先创建或选择一个班级' });
      return;
    }
    if (!noticeTitle.trim() || publishing) return;
    noticeListRequest.current++;
    setPublishing(true);
    try {
      await noticeService.create({ class_id: noticeClassID, title: noticeTitle.trim(), body: noticeBody.trim(), attachments: noticeAttachments });
      setNoticeTitle('');
      setNoticeBody('');
      setNoticeAttachments([]);
      setNoticeModalOpen(false);
      await loadNotices(1, false, false, { refreshLoadedPages: true });
      refreshMessageCenterSummaryAfterMutation();
    } catch (error) {
      notifyRequestError(error, '发布通知失败，请稍后重试');
    }
    finally { setPublishing(false); }
  }, [noticeTitle, noticeBody, noticeAttachments, noticeClassID, publishing, loadNotices, notifyRequestError, toast]);

  const remindUnconfirmedStudents = useCallback(async (noticeID: string) => {
    if (remindingNoticeID) return;
    setRemindingNoticeID(noticeID);
    try {
      const result = await noticeService.remind(noticeID);
      if (result.count === 0) {
        toast({ type: 'success', title: '该通知已由全部学生确认' });
      } else if (result.queued_count > 0) {
        toast({ type: 'success', title: `已为 ${result.count} 位未确认学生提交提醒` });
      } else {
        toast({ type: 'success', title: `${result.count} 位未确认学生的提醒已在队列中` });
      }
      if (activeNoticeIDRef.current === noticeID) await loadNoticeDetail(noticeID);
    } catch (error) {
      notifyRequestError(error, '提醒未确认学生失败，请检查消息提醒服务是否已启用');
    } finally {
      setRemindingNoticeID('');
    }
  }, [loadNoticeDetail, notifyRequestError, remindingNoticeID, toast]);

  // ---- actions: threads -----------------------------------------------
  const replyThread = useCallback(async () => {
    if ((!answerDraft.trim() && answerAttachments.length === 0) || !activeThread || activeThread.id !== activeThreadId || sendingAnswer || answerUploading) return;
    const threadID = activeThread.id;
    const submittedDraft = answerDraft;
    const submittedAttachments = answerAttachments;
    threadRequest.current++;
    threadListRequest.current++;
    setSendingAnswer(true);
    try {
      await qaThreadService.sendMessage(threadID, submittedDraft.trim(), submittedAttachments);
      setAnswerDrafts((current) => {
        if ((current[threadID] ?? '') !== submittedDraft) return current;
        const next = { ...current };
        delete next[threadID];
        return next;
      });
      setAnswerAttachmentDrafts((current) => {
        if (current[threadID] !== submittedAttachments) return current;
        const next = { ...current };
        delete next[threadID];
        return next;
      });
      if (activeThreadIDRef.current === threadID) await loadThreadDetail(threadID, true);
      await loadThreads(1, false, false, { refreshLoadedPages: true });
      refreshMessageCenterSummaryAfterMutation();
    } catch (error) {
      notifyRequestError(error, '发送答复失败，请稍后重试');
    }
    finally { setSendingAnswer(false); }
  }, [activeThread, answerAttachments, answerDraft, answerUploading, activeThreadId, sendingAnswer, loadThreadDetail, loadThreads, notifyRequestError]);

  const loadOlderThreadMessages = useCallback(async () => {
    if (!activeThread || activeThread.id !== activeThreadIDRef.current || loadingOlderThreadMessagesRef.current || activeThread.messages.length >= activeThread.messages_total) return;
    const threadID = activeThread.id;
    const request = ++threadRequest.current;
    loadingOlderThreadMessagesRef.current = true;
    setLoadingOlderThreadMessages(true);
    try {
      const nextPage = activeThread.messages_page + 1;
      const detail = await qaThreadService.get(threadID, { messages_page: nextPage, messages_page_size: activeThread.messages_page_size });
      if (request !== threadRequest.current) return;
      let messages = mergeMessagesByID(activeThread.messages, detail.messages);
      let messagesTotal = detail.messages_total;
      const headDetail = await qaThreadService.get(threadID, { messages_page: 1, messages_page_size: activeThread.messages_page_size });
      if (request !== threadRequest.current) return;
      const currentHeadID = activeThread.messages.at(-1)?.id ?? '';
      const serverHeadID = headDetail.messages.at(-1)?.id ?? '';
      const headShifted = currentHeadID !== serverHeadID
        || activeThread.messages_total !== headDetail.messages_total
        || detail.messages_total !== headDetail.messages_total;
      const loadedWindowDrifted = activeThread.messages.length < headDetail.messages_total
        && activeThread.messages.length !== Math.min(
          headDetail.messages_total,
          activeThread.messages_page * activeThread.messages_page_size,
        );
      if (headShifted || loadedWindowDrifted || messages.length < Math.min(messagesTotal, nextPage * activeThread.messages_page_size)) {
        const stableWindow = await fetchStableOffsetMessageWindow(nextPage, activeThread.messages_page_size, async (messagesPage) => {
          const pageDetail = await qaThreadService.get(threadID, { messages_page: messagesPage, messages_page_size: activeThread.messages_page_size });
          return { messages: pageDetail.messages, messages_total: pageDetail.messages_total };
        });
        if (request !== threadRequest.current) return;
        messages = stableWindow.messages;
        messagesTotal = stableWindow.total;
      }
      setActiveThread((current) => current?.id === detail.id ? {
        ...detail,
        read_through_message_id: current.read_through_message_id,
        messages,
        messages_total: messagesTotal,
        messages_page: nextPage,
      } : current);
    } catch (error) {
      if (request === threadRequest.current && activeThreadIDRef.current === threadID) {
        notifyRequestError(error, '加载更早答疑消息失败，请稍后重试');
      }
    } finally {
      if (activeThreadIDRef.current === threadID) {
        loadingOlderThreadMessagesRef.current = false;
        setLoadingOlderThreadMessages(false);
      }
    }
  }, [activeThread, notifyRequestError]);

  const loadMoreNotices = useCallback(async () => {
    if (loadingMoreListRef.current || notices.length >= noticeTotal) return;
    loadingMoreListRef.current = true;
    setLoadingMoreList('notices');
    try {
      const error = await loadNotices(noticePage + 1, true);
      if (error) notifyRequestError(error, '加载更多通知失败，请稍后重试');
    } finally {
      loadingMoreListRef.current = false;
      setLoadingMoreList('');
    }
  }, [notices.length, noticeTotal, loadNotices, noticePage, notifyRequestError]);

  const loadMoreThreads = useCallback(async () => {
    if (loadingMoreListRef.current || threads.length >= threadTotal) return;
    loadingMoreListRef.current = true;
    setLoadingMoreList('threads');
    try {
      const error = await loadThreads(threadPage + 1, true);
      if (error) notifyRequestError(error, '加载更多答疑失败，请稍后重试');
    } finally {
      loadingMoreListRef.current = false;
      setLoadingMoreList('');
    }
  }, [threads.length, threadTotal, loadThreads, notifyRequestError, threadPage]);

  const updateThreadStatus = useCallback(async (id: string, status: string) => {
    if (threadStatusUpdateRef.current) return;
    const previousStatus = activeThread?.id === id
      ? activeThread.status
      : threadsRef.current.find((thread) => thread.id === id)?.status;
    if (!previousStatus || previousStatus === status) return;
    threadStatusUpdateRef.current = id;
    setUpdatingThreadStatusId(id);
    threadRequest.current++;
    threadListRequest.current++;
    setActiveThread((current) => current?.id === id ? { ...current, status } : current);
    setThreads((current) => current.map((thread) => thread.id === id ? { ...thread, status } : thread));
    try {
      await qaThreadService.updateStatus(id, status);
      const listError = await loadThreads(1, false, false, { refreshLoadedPages: true });
      if (listError) setListLoadError(listError);
      refreshMessageCenterSummaryAfterMutation();
    } catch (error) {
      setActiveThread((current) => current?.id === id && current.status === status
        ? { ...current, status: previousStatus }
        : current);
      setThreads((current) => current.map((thread) => thread.id === id && thread.status === status
        ? { ...thread, status: previousStatus }
        : thread));
      notifyRequestError(error, '更新答疑状态失败，请稍后重试');
    } finally {
      if (threadStatusUpdateRef.current === id) threadStatusUpdateRef.current = '';
      setUpdatingThreadStatusId((current) => current === id ? '' : current);
    }
  }, [activeThread, loadThreads, notifyRequestError]);

  const selectThread = useCallback((id: string) => {
    clearItemDeepLink('answers');
    if (!activateThread(id)) {
      setActiveThread(null);
      void loadThreadDetail(id);
    }
  }, [activateThread, clearItemDeepLink, loadThreadDetail]);

  useEffect(() => {
    if (handledLocationKey.current === location.key) return;
    handledLocationKey.current = location.key;
    const tab = parseTeacherTab(searchParams.get('tab'));
    const id = searchParams.get('id') ?? '';
    setActiveTab(tab);
    if (!id) {
      pendingDeepLink.current = null;
      return;
    }
    pendingDeepLink.current = { tab, id };
    if (tab === 'private' && !activateConversation(id)) {
      setActiveConv(null);
      void loadConvDetail(id);
    }
    if (tab === 'notices') {
      if (!activateNotice(id)) {
        setActiveNotice(null);
        void loadNoticeDetail(id);
      }
    }
    if (tab === 'answers' && !activateThread(id)) {
      setActiveThread(null);
      void loadThreadDetail(id);
    }
  }, [activateConversation, activateNotice, activateThread, loadConvDetail, loadNoticeDetail, loadThreadDetail, location.key, searchParams]);

  const retryActiveList = useCallback(async () => {
    let error: ListLoadResult = null;
    if (activeTab === 'private') error = await loadConversations(1, false, false, { refreshLoadedPages: true });
    if (activeTab === 'notices') error = await loadNotices(1, false, false, { refreshLoadedPages: true });
    if (activeTab === 'answers') error = await loadThreads(1, false, false, { refreshLoadedPages: true });
    setListLoadError(error);
  }, [activeTab, loadConversations, loadNotices, loadThreads]);

  const visibleConversationMessages = useMemo(() => {
    if (!activeConv) return [];
    if (!conversationSearchOpen || !conversationMessageSearch.trim()) return activeConv.messages;
    return activeConv.messages.filter((message) => matchesAllKeywords(message.text, conversationMessageSearch));
  }, [activeConv, conversationMessageSearch, conversationSearchOpen]);

  // ---- render ---------------------------------------------------------
  if (initialLoad && loading) {
    return (
      <MainLayout>
        <div className="container mx-auto flex max-w-7xl items-center justify-center px-4 py-24">
          <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="container mx-auto max-w-7xl px-4 py-5 sm:py-8">
        <div className="mb-5 flex flex-col gap-4 rounded-2xl border border-surface-200/80 bg-white/85 px-5 py-4 shadow-sm backdrop-blur dark:border-surface-700 dark:bg-surface-900/85 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100">消息中心</h1>
            <p className="mt-1 text-sm text-surface-500 dark:text-surface-400">管理学生私信、班级通知、答疑与论坛互动</p>
          </div>
          {activeTab !== 'forum' && <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
            <Input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder={activeTab === 'private' ? '搜索学生、班级…' : activeTab === 'notices' ? '搜索通知标题、内容…' : '搜索问题、知识点…'} className="pl-10" />
          </div>}
        </div>

        {loadError && (
          <RequestErrorNotice
            error={loadError}
            onRetry={() => void reloadInitialData(true)}
            onRefresh={() => void reloadInitialData(true)}
            className="mb-4"
          />
        )}
        {listLoadError && (
          <RequestErrorNotice
            error={listLoadError}
            onRetry={() => void retryActiveList()}
            onRefresh={() => void retryActiveList()}
            className="mb-4"
          />
        )}
        {summaryError && (
          <RequestErrorNotice
            error={toAppError(
              summaryError,
              summary ? '消息计数刷新失败，当前显示上次结果' : '消息计数加载失败，页签角标暂不可用',
            )}
            onRetry={summaryRefreshing ? undefined : () => void refreshSummary().catch(() => undefined)}
            onRefresh={summaryRefreshing ? undefined : () => void refreshSummary().catch(() => undefined)}
            className="mb-4"
          />
        )}

        <Tabs
          defaultValue="private"
          value={activeTab}
          keepMounted={false}
          onValueChange={(value) => {
            if (value === 'notices') activateNotice('');
            if (value === 'answers') activateThread('');
            setActiveTab(value);
            setSearchTerm('');
            setServerSearch('');
            setConversationSelectionMode(false);
            setSelectedConversationIds([]);
            setSearchParams({ tab: value });
          }}
        >
          <div className="flex">
            <TabsList
              aria-label="消息分类"
              aria-orientation="vertical"
              className="h-auto min-h-[620px] w-12 shrink-0 flex-col justify-start gap-2 self-stretch rounded-xl border border-surface-200 bg-surface-100 p-1 shadow-sm sm:w-14 sm:p-2 dark:border-surface-700 dark:bg-surface-900"
            >
              <MessageCenterSideTab value="private" label="私信" count={tabCounts.private} icon={MessageSquare} />
              <MessageCenterSideTab value="notices" label="通知" count={tabCounts.notices} icon={Bell} />
              <MessageCenterSideTab value="answers" label="答疑" count={tabCounts.answers} icon={HelpCircle} />
              <MessageCenterSideTab value="forum" label="全站论坛" count={tabCounts.forum} icon={MessagesSquare} />
            </TabsList>

            <div className="min-w-0 flex-1">

          {/* ============================================================ PRIVATE */}
          <TabsContent value="private" className="mt-0">
            <div className="grid h-[620px] min-h-0 grid-cols-1 lg:grid-cols-[300px_1fr]">
              <Card className={cn('min-h-0 overflow-hidden rounded-2xl border-surface-200/80 shadow-sm dark:border-surface-700', activeConvId ? 'hidden lg:block' : '')}>
                <CardContent className="flex h-full min-h-0 flex-col p-0">
                  <div className="flex h-16 shrink-0 items-center gap-2 border-b border-surface-100 px-3 dark:border-surface-800">
                    <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-surface-900 dark:text-surface-100">
                      {conversationSelectionMode ? `已选择 ${selectedConversationIds.length}` : '历史会话'}
                    </h2>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn('h-9 w-9 shrink-0', conversationSelectionMode && 'bg-primary-50 text-primary-600 dark:bg-primary-950/30 dark:text-primary-400')}
                      onClick={() => {
                        setConversationSelectionMode((current) => !current);
                        setSelectedConversationIds([]);
                      }}
                      disabled={archivingConversations || convItems.length === 0}
                      aria-label={conversationSelectionMode ? '退出多选' : '多选会话'}
                      aria-pressed={conversationSelectionMode}
                      title={conversationSelectionMode ? '退出多选' : '多选会话'}
                    >
                      <SquareCheckBig className="h-5 w-5" />
                    </Button>
                    {conversationSelectionMode ? (
                      <Button size="sm" className="shrink-0 px-3" onClick={archiveSelectedConversations} disabled={selectedConversationIds.length === 0 || archivingConversations}>
                        {archivingConversations ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Archive className="mr-1 h-4 w-4" />}
                        归档
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="shrink-0 px-3"
                        onClick={() => { resetNewConversationForm(); void loadStudentContacts(); setNewConvOpen(true); }}
                        aria-label="新建私信"
                        title="新建私信"
                      >
                        <Plus className="mr-1 h-4 w-4" />
                        新建
                      </Button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {convItems.map((c) => (
                      <button key={c.id} type="button" disabled={conversationSelectionMode && archivingConversations} onClick={() => {
                        if (!conversationSelectionMode) {
                          openConversation(c.id);
                          return;
                        }
                        setSelectedConversationIds((current) => current.includes(c.id)
                          ? current.filter((id) => id !== c.id)
                          : [...current, c.id]);
                      }}
                        aria-pressed={conversationSelectionMode ? selectedConversationIds.includes(c.id) : undefined}
                        className={cn(
                          'w-full border-b border-surface-100 px-3 py-2 text-left last:border-b-0 hover:bg-surface-50 disabled:pointer-events-none disabled:opacity-60 dark:border-surface-800 dark:hover:bg-surface-800',
                          !conversationSelectionMode && activeConvId === c.id && 'bg-primary-50 dark:bg-primary-950/30',
                          conversationSelectionMode && selectedConversationIds.includes(c.id) && 'bg-primary-50 dark:bg-primary-950/30',
                        )}>
                        <div className="flex items-center gap-3"><span className={cn('grid shrink-0 place-items-center border', conversationSelectionMode ? 'h-5 w-5 rounded' : 'h-10 w-10 rounded-full shadow-sm', conversationSelectionMode && selectedConversationIds.includes(c.id) ? 'border-primary-600 bg-primary-600 text-white' : 'border-surface-300 bg-white text-surface-800 dark:border-surface-600 dark:bg-surface-900 dark:text-surface-100')}>{conversationSelectionMode ? selectedConversationIds.includes(c.id) && <Check className="h-3.5 w-3.5" /> : <UserRound className="h-5 w-5" />}</span><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-surface-900 dark:text-surface-100">{c.studentName}</div><div className="mt-0.5 truncate text-xs text-surface-500 dark:text-surface-400">{c.lastMessage || c.className}</div></div><div className="flex shrink-0 flex-col items-end gap-1 text-xs"><span className="text-surface-400">{c.lastTime}</span><span className={c.unread ? 'text-red-500' : c.pendingReply ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}>{c.unread ? '未读' : c.pendingReply ? '未回复' : '已回复'}</span></div></div>
                      </button>
                    ))}
                    {convItems.length < conversationTotal && <Button variant="outline" size="sm" className="m-3 w-[calc(100%-1.5rem)]" onClick={loadMoreConversations} disabled={loadingMoreList !== ''}>{loadingMoreList === 'conversations' ? '加载中…' : '加载更多对话'}</Button>}
                  </div>
                </CardContent>
              </Card>

              <Card className={cn('min-h-0 overflow-hidden rounded-2xl border-surface-200/80 shadow-sm dark:border-surface-700', !activeConvId ? 'hidden lg:block' : '')}>
                <CardContent className="flex h-full min-h-0 flex-col p-0">
                  {conversationDetailLoading ? (
                    <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6">
                      <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
                      <Button variant="ghost" size="sm" className="lg:hidden" onClick={showConversationList}><ArrowLeft className="mr-1 h-4 w-4" />返回列表</Button>
                    </div>
                  ) : conversationDetailError ? (
                    <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-surface-500 dark:text-surface-400">
                      <RequestErrorNotice
                        error={conversationDetailError}
                        onRetry={() => activeConvId && void loadConvDetail(activeConvId)}
                        onRefresh={() => activeConvId && void loadConvDetail(activeConvId)}
                        className="w-full max-w-lg text-left"
                      />
                      <Button variant="ghost" size="sm" className="lg:hidden" onClick={showConversationList}><ArrowLeft className="mr-1 h-4 w-4" />返回列表</Button>
                    </div>
                  ) : activeConv && activeConv.id === activeConvId ? (
                    <>
                      <div ref={conversationDetailRef} className="shrink-0 border-b border-surface-100 p-3 sm:p-4 dark:border-surface-800">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <Button variant="ghost" size="sm" className="mb-2 -ml-2 lg:hidden" onClick={showConversationList}><ArrowLeft className="mr-1 h-4 w-4" />返回列表</Button>
                            <div className="text-lg font-semibold text-surface-900 dark:text-surface-100">{activeConv.student_name}</div>
                            <div className="text-sm text-surface-500 dark:text-surface-400">{activeConv.class_name}</div>
                          </div>
                          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                            {conversationSearchOpen && (
                              <div role="search" className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
                                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
                                <Input
                                  autoFocus
                                  value={conversationMessageSearch}
                                  onChange={(event) => setConversationMessageSearch(event.target.value)}
                                  placeholder={`查找与 ${activeConv.student_name} 的聊天内容`}
                                  className={cn('pl-9 pr-16', conversationSearchError && 'border-amber-500 focus-visible:ring-amber-500')}
                                />
                                <span
                                  title={conversationSearchError || undefined}
                                  className={cn('pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-surface-500 dark:text-surface-400', conversationSearchError && 'text-amber-600 dark:text-amber-400')}
                                >
                                  {conversationSearchError ? '加载失败' : loadingConversationSearch ? '载入中…' : conversationMessageSearch.trim() ? `${visibleConversationMessages.length} 条` : `共 ${activeConv.messages_total} 条`}
                                </span>
                              </div>
                            )}
                            <Button variant="outline" size="sm" className="shrink-0" onClick={() => void toggleConversationSearch()} disabled={loadingConversationSearch}>
                              {loadingConversationSearch ? <Loader2 className="h-4 w-4 animate-spin sm:mr-2" /> : conversationSearchOpen ? <X className="h-4 w-4 sm:mr-2" /> : <Search className="mr-2 h-4 w-4" />}
                              <span className={conversationSearchOpen ? 'hidden sm:inline' : ''}>{loadingConversationSearch ? '载入记录' : conversationSearchOpen ? '关闭查找' : '查找聊天记录'}</span>
                            </Button>
                          </div>
                        </div>
                      </div>
                      <div ref={conversationViewportRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-5">
                        {!conversationSearchOpen && activeConv.messages.length < activeConv.messages_total && <Button variant="outline" size="sm" className="w-full" onClick={loadOlderConversationMessages} disabled={loadingOlderMessages}>{loadingOlderMessages ? '加载中…' : '加载更早消息'}</Button>}
                        {conversationSearchOpen && conversationMessageSearch.trim() && !loadingConversationSearch && visibleConversationMessages.length === 0 && (
                          <div className="flex min-h-32 items-center justify-center text-sm text-surface-500 dark:text-surface-400">未找到匹配的聊天记录</div>
                        )}
                        {visibleConversationMessages.map((msg) => (
                          <div key={msg.id} className="flex w-full">
                            <div className={cn('max-w-[80%]', msg.from === 'teacher' ? 'ml-auto text-right' : 'mr-auto')}>
                              {msg.text && <div className={cn(
                                'inline-block rounded-lg px-4 py-3 text-sm',
                                msg.from === 'teacher' ? 'bg-primary-600 text-white' : 'bg-surface-100 text-surface-800 dark:bg-surface-800 dark:text-surface-100',
                              )}>{msg.text}</div>}
                              <MessageAttachments attachments={msg.attachments} />
                              <div className={cn('mt-1 flex gap-2 text-xs text-surface-400', msg.from === 'teacher' ? 'justify-end' : 'justify-start')}>
                                <span>{formatRelativeTime(msg.time)}</span>
                                {msg.from === 'teacher' && <span>{msg.read_by_recipient ? '学生已读' : '学生未读'}</span>}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="shrink-0 border-t border-surface-100 p-4 dark:border-surface-800">
                        <MessageComposer
                          key={activeConvId}
                          value={messageDraft}
                          onChange={(value) => {
                            const conversationID = activeConvId;
                            if (conversationID) setMessageDrafts((current) => ({ ...current, [conversationID]: value }));
                          }}
                          attachments={messageAttachments}
                          onAttachmentsChange={(attachments) => {
                            const conversationID = activeConvId;
                            if (conversationID) setMessageAttachmentDrafts((current) => ({ ...current, [conversationID]: attachments }));
                          }}
                          onUploadingChange={setMessageUploading}
                          onError={(message) => toast({ type: 'error', title: message })}
                          onFeedback={(feedback) => toast(feedback)}
                          onSend={sendPrivateMessage}
                          placeholder="输入给学生的回复"
                          disabled={sendingMsg}
                          uploading={messageUploading}
                          sending={sendingMsg}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="flex h-full items-center justify-center p-8 text-sm text-surface-500 dark:text-surface-400">
                      {activeConvId ? '暂无可显示的私信对话' : '请选择联系人查看私信'}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ============================================================ NOTICES */}
          <TabsContent value="notices" className="mt-0">
            <div className="grid grid-cols-1 lg:h-[620px] lg:min-h-0 lg:grid-cols-[360px_1fr]">
              <Card className="flex max-h-[620px] min-h-0 flex-col overflow-hidden rounded-2xl border-surface-200/80 shadow-sm dark:border-surface-700">
                <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                  <div className="flex h-16 shrink-0 items-center gap-2 border-b border-surface-100 px-3 dark:border-surface-800">
                    <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-surface-900 dark:text-surface-100">历史通知</h2>
                    <MessageCenterFilterMenu options={noticeStatuses} value={noticeStatus} onValueChange={setNoticeStatus} />
                    <Button size="sm" className="shrink-0 px-3" onClick={() => setNoticeModalOpen(true)}>
                      <Megaphone className="mr-1 h-4 w-4" />发布
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {notices.map((n) => (
                      <button key={n.id} type="button" onClick={() => {
                        clearItemDeepLink('notices');
                        if (!activateNotice(n.id)) {
                          setActiveNotice(null);
                          void loadNoticeDetail(n.id);
                        }
                      }}
                        className={cn(
                          'w-full border-b border-surface-100 px-3 py-2 text-left last:border-b-0 hover:bg-surface-50 dark:border-surface-800 dark:hover:bg-surface-800',
                          activeNoticeId === n.id && 'bg-primary-50 dark:bg-primary-950/30',
                        )}>
                        <div className="flex items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-surface-300 bg-white text-surface-800 dark:border-surface-600 dark:bg-surface-900 dark:text-surface-100"><Bell className="h-5 w-5" /></span><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-surface-900 dark:text-surface-100">{n.title}</div><div className="mt-0.5 truncate text-xs text-surface-500 dark:text-surface-400">通知 · {n.class_name}</div></div><div className="flex shrink-0 flex-col items-end gap-1 text-xs"><span className="text-surface-400">{formatRelativeTime(n.published_at)}</span><span className={n.confirmed_count >= n.total_count ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>{n.confirmed_count}/{n.total_count} 已确认</span></div></div>
                      </button>
                    ))}
                    {notices.length < noticeTotal && <Button variant="outline" size="sm" className="m-3 w-[calc(100%-1.5rem)]" onClick={loadMoreNotices} disabled={loadingMoreList !== ''}>{loadingMoreList === 'notices' ? '加载中…' : '加载更多通知'}</Button>}
                  </div>
                </CardContent>
              </Card>

              <Card className="flex max-h-[620px] min-h-0 flex-col overflow-hidden rounded-2xl border-surface-200/80 shadow-sm dark:border-surface-700">
                <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
                  {noticeDetailLoading ? (
                    <div className="flex min-h-48 items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
                    </div>
                  ) : noticeDetailError ? (
                    <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-sm text-surface-500 dark:text-surface-400">
                      <RequestErrorNotice
                        error={noticeDetailError}
                        onRetry={() => activeNoticeId && void loadNoticeDetail(activeNoticeId)}
                        onRefresh={() => activeNoticeId && void loadNoticeDetail(activeNoticeId)}
                        className="w-full max-w-lg text-left"
                      />
                    </div>
                  ) : activeNotice ? (
                    <div className="space-y-5">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="text-sm text-surface-500 dark:text-surface-400">{activeNotice.class_name} · {formatRelativeTime(activeNotice.published_at)}</div>
                          <h2 className="mt-2 text-xl font-semibold text-surface-900 dark:text-surface-100">{activeNotice.title}</h2>
                        </div>
                        <Badge variant={activeNotice.confirmed_count >= activeNotice.total_count ? 'success' : 'warning'}>
                          {activeNotice.confirmed_count}/{activeNotice.total_count} 已确认
                        </Badge>
                      </div>
                      <p className="leading-7 text-surface-700 dark:text-surface-300">{activeNotice.body}</p>
                      <MessageAttachments attachments={activeNotice.attachments} />
                      {activeNotice.unconfirmed_students.length > 0 && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-medium text-surface-700 dark:text-surface-300">未确认学生</div>
                            <Button variant="outline" size="sm" onClick={() => void remindUnconfirmedStudents(activeNotice.id)} disabled={Boolean(remindingNoticeID)}>
                              {remindingNoticeID === activeNotice.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Bell className="mr-2 h-4 w-4" />}
                              提醒未确认学生
                            </Button>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {activeNotice.unconfirmed_students.map((name) => (
                              <span key={name} className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                                <Users className="h-3 w-3" />{name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center p-8 text-sm text-surface-500 dark:text-surface-400">
                      {activeNoticeId ? '暂无可显示的通知内容' : '请选择通知查看通知内容'}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ============================================================ ANSWERS */}
          <TabsContent value="answers" className="mt-0">
            <div className="grid grid-cols-1 lg:h-[620px] lg:min-h-0 lg:grid-cols-[360px_1fr]">
              <Card className="flex max-h-[620px] min-h-0 flex-col overflow-hidden rounded-2xl border-surface-200/80 shadow-sm dark:border-surface-700">
                <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                  <div className="flex h-16 shrink-0 items-center gap-2 border-b border-surface-100 px-3 dark:border-surface-800">
                    <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-surface-900 dark:text-surface-100">历史答疑</h2>
                    <MessageCenterFilterMenu options={answerStatuses} value={answerStatus} onValueChange={setAnswerStatus} subject="答疑" />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {threads.map((t) => (
                      <button key={t.id} type="button" onClick={() => selectThread(t.id)}
                        className={cn(
                          'w-full border-b border-surface-100 px-3 py-2 text-left last:border-b-0 hover:bg-surface-50 dark:border-surface-800 dark:hover:bg-surface-800',
                          activeThreadId === t.id && 'bg-primary-50 dark:bg-primary-950/30',
                        )}>
                        <div className="flex items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-surface-300 bg-white text-surface-800 dark:border-surface-600 dark:bg-surface-900 dark:text-surface-100"><HelpCircle className="h-5 w-5" /></span><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-surface-900 dark:text-surface-100">{t.title}</div><div className="mt-0.5 truncate text-xs text-surface-500 dark:text-surface-400">{t.student_name} · {t.source}</div></div><div className="flex shrink-0 flex-col items-end gap-1 text-xs"><span className="text-surface-400">{formatRelativeTime(t.last_update)}</span><span className={t.status === '待回复' ? 'text-red-500' : t.status === '已回复' || t.status === '已解决' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>{t.status}</span></div></div>
                      </button>
                    ))}
                    {threads.length < threadTotal && <Button variant="outline" size="sm" className="m-3 w-[calc(100%-1.5rem)]" onClick={loadMoreThreads} disabled={loadingMoreList !== ''}>{loadingMoreList === 'threads' ? '加载中…' : '加载更多答疑'}</Button>}
                  </div>
                </CardContent>
              </Card>

              <Card className="flex max-h-[620px] min-h-0 flex-col overflow-hidden rounded-2xl border-surface-200/80 shadow-sm dark:border-surface-700">
                <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
                  {threadDetailLoading ? (
                    <div className="flex min-h-48 items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
                    </div>
                  ) : threadDetailError ? (
                    <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-sm text-surface-500 dark:text-surface-400">
                      <RequestErrorNotice
                        error={threadDetailError}
                        onRetry={() => activeThreadId && void loadThreadDetail(activeThreadId)}
                        onRefresh={() => activeThreadId && void loadThreadDetail(activeThreadId)}
                        className="w-full max-w-lg text-left"
                      />
                    </div>
                  ) : activeThread && activeThread.id === activeThreadId ? (
                    <div className="space-y-5">
                      <div ref={threadDetailRef} className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="text-sm text-surface-500 dark:text-surface-400">
                            {activeThread.student_name} · {activeThread.class_name} · {activeThread.source}
                          </div>
                          <h2 className="mt-2 text-xl font-semibold text-surface-900 dark:text-surface-100">{activeThread.title}</h2>
                          {activeThread.knowledge_point && <div className="mt-1 text-xs text-surface-500">知识点：{activeThread.knowledge_point}</div>}
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={threadStatusVariant[activeThread.status] ?? 'secondary'}>{activeThread.status}</Badge>
                          {updatingThreadStatusId && <Loader2 className="h-4 w-4 animate-spin text-surface-500" aria-label="状态更新中" />}
                          <select
                            value={activeThread.status}
                            onChange={(e) => updateThreadStatus(activeThread.id, e.target.value)}
                            disabled={Boolean(updatingThreadStatusId)}
                            aria-busy={Boolean(updatingThreadStatusId)}
                            className="h-8 rounded-md border border-surface-200 bg-white px-2 text-xs dark:border-surface-700 dark:bg-surface-800 dark:text-surface-100"
                          >
                            <option value="待回复">待回复</option>
                            <option value="已回复">已回复</option>
                            <option value="已解决">已解决</option>
                            <option value="需跟进">需跟进</option>
                          </select>
                        </div>
                      </div>
                      <div className="rounded-md bg-surface-50 p-4 text-sm leading-6 text-surface-700 dark:bg-surface-800 dark:text-surface-300">
                        {activeThread.context}
                      </div>
                      <div className="space-y-3">
                        {activeThread.messages.length < activeThread.messages_total && <Button variant="outline" size="sm" className="w-full" onClick={loadOlderThreadMessages} disabled={loadingOlderThreadMessages}>{loadingOlderThreadMessages ? '加载中…' : '加载更早消息'}</Button>}
                        {activeThread.messages.map((msg) => (
                          <div key={msg.id} className={cn('rounded-md border p-3', msg.from === 'teacher' ? 'border-primary-200 bg-primary-50/30 dark:border-primary-800 dark:bg-primary-950/20' : 'border-surface-200 dark:border-surface-700')}>
                            <div className="mb-1 flex items-center gap-2">
                              <span className={cn('text-xs font-medium', msg.from === 'teacher' ? 'text-primary-600 dark:text-primary-400' : 'text-emerald-600 dark:text-emerald-400')}>
                                {msg.from === 'teacher' ? '我' : activeThread.student_name}
                              </span>
                            </div>
                            <div className="text-sm text-surface-700 dark:text-surface-300">{msg.text}</div>
                            <MessageAttachments attachments={msg.attachments} />
                            <div className="mt-2 text-xs text-surface-400">{formatRelativeTime(msg.time)}</div>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-surface-100 pt-4 dark:border-surface-800">
                        <MessageComposer
                          key={activeThreadId}
                          value={answerDraft}
                          onChange={(value) => {
                            const threadID = activeThreadId;
                            if (threadID) setAnswerDrafts((current) => ({ ...current, [threadID]: value }));
                          }}
                          attachments={answerAttachments}
                          onAttachmentsChange={(attachments) => {
                            const threadID = activeThreadId;
                            if (threadID) setAnswerAttachmentDrafts((current) => ({ ...current, [threadID]: attachments }));
                          }}
                          onUploadingChange={setAnswerUploading}
                          onError={(message) => toast({ type: 'error', title: message })}
                          onFeedback={(feedback) => toast(feedback)}
                          onSend={replyThread}
                          placeholder="回复这位同学"
                          sendLabel="回复"
                          disabled={sendingAnswer}
                          uploading={answerUploading}
                          sending={sendingAnswer}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center p-8 text-sm text-surface-500 dark:text-surface-400">
                      {activeThreadId ? '暂无可显示的答疑内容' : '请选择答疑查看内容'}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ============================================================ FORUM */}
          <TabsContent value="forum" className="mt-0">
            <ForumCenter
              role="teacher"
              postId={searchParams.get('tab') === 'forum' ? searchParams.get('id') ?? '' : ''}
              onPostChange={(id) => setSearchParams(id ? { tab: 'forum', id } : { tab: 'forum' }, { replace: true })}
              onUnreadChange={refreshMessageCenterSummaryAfterMutation}
            />
          </TabsContent>
            </div>
          </div>
        </Tabs>

        {/* New conversation modal */}
        <Modal isOpen={newConvOpen} onClose={closeNewConversationModal} title="新建私信对话" className="max-w-lg">
          <div className="space-y-4">
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300">选择学生</label>
            <Input value={contactSearch} onChange={(e) => {
              contactSearchRequest.current++;
              setContactSearch(e.target.value);
              setGlobalSearchResults([]);
              if (selectedStudentId) {
                setSelectedStudentId('');
                setNewConvDraft('');
              }
            }}
              placeholder="搜索学生姓名或 ID…" />
            {allStudentSearchResults.length > 0 ? (
              <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-surface-200 dark:border-surface-700">
                {allStudentSearchResults.map((c) => (
                  <button key={c.id} type="button"
                    onClick={() => {
                      if (selectedStudentId && selectedStudentId !== c.id) setNewConvDraft('');
                      setSelectedStudentId(c.id);
                      setContactSearch('');
                      setGlobalSearchResults([]);
                    }}
                    className={cn('w-full px-4 py-2.5 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-800',
                      selectedStudentId === c.id && 'bg-primary-50 ring-1 ring-inset ring-primary-200 dark:bg-primary-950/30 dark:ring-primary-800')}>
                    <div className="font-medium text-surface-900 dark:text-surface-100">{c.display_name}</div>
                    <div className="flex items-center justify-between text-xs text-surface-500 dark:text-surface-400">
                      <span>{c.scope || '全校'}</span>
                      <span className="font-mono text-surface-400">{c.id}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : contactSearch.trim() ? (
              <p className="text-sm text-surface-500 dark:text-surface-400">未找到匹配的学生。</p>
            ) : studentContacts.length === 0 ? (
              <p className="text-sm text-surface-500 dark:text-surface-400">暂无班级学生。</p>
            ) : null}
            <textarea value={newConvDraft} onChange={(e) => setNewConvDraft(e.target.value)}
              placeholder="可以先写一句要发给学生的消息"
              className="min-h-28 w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-100"
            />
            <MessageAttachmentPicker
              value={newConvAttachments}
              onChange={setNewConvAttachments}
              onUploadingChange={setNewConvUploading}
              onError={(message) => toast({ type: 'error', title: message })}
              onFeedback={(feedback) => toast(feedback)}
              disabled={creatingConv}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeNewConversationModal}>取消</Button>
              <Button onClick={createConversation} disabled={!selectedStudentId || creatingConv || newConvUploading}>
                {creatingConv ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}创建对话
              </Button>
            </div>
          </div>
        </Modal>

        {/* Publish notice modal */}
        <Modal isOpen={noticeModalOpen} onClose={() => setNoticeModalOpen(false)} title="发布班级通知" className="max-w-xl">
          <div className="space-y-4">
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300">目标班级</label>
            <select value={noticeClassID} onChange={(e) => setNoticeClassID(e.target.value)}
              className="h-10 w-full rounded-md border border-surface-200 bg-white px-3 text-sm dark:border-surface-700 dark:bg-surface-800 dark:text-surface-100">
              {noticeClasses.length > 0
                ? noticeClasses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)
                : <option value="">暂无可用班级</option>}
            </select>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300">通知标题</label>
            <Input value={noticeTitle} onChange={(e) => setNoticeTitle(e.target.value)} placeholder="通知标题" />
            <textarea value={noticeBody} onChange={(e) => setNoticeBody(e.target.value)}
              placeholder="通知正文"
              className="min-h-32 w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-100"
            />
            <MessageAttachmentPicker
              value={noticeAttachments}
              onChange={setNoticeAttachments}
              onUploadingChange={setNoticeUploading}
              onError={(message) => toast({ type: 'error', title: message })}
              onFeedback={(feedback) => toast(feedback)}
              disabled={publishing}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setNoticeModalOpen(false)}>取消</Button>
              <Button onClick={publishNotice} disabled={publishing || noticeUploading || !noticeClassID}>
                {publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}发布
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </MainLayout>
  );
};
