import { useState, useRef, useEffect, useCallback } from 'react';
import { Chat } from '../types';
import { loadChats, saveChats, loadActiveChatId, saveActiveChatId, clearChatHistory } from '../utils/chatStorage';

export interface UseChatReturn {
  chats: Chat[];
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
  activeChatId: string | null;
  setActiveChatId: (id: string | null) => void;
  activeChat: Chat | undefined;
  handleCreateChat: () => string;
  handleDeleteChat: (chatId: string) => void;
  handleClearHistory: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  tabsContainerRef: React.RefObject<HTMLDivElement>;
  canScrollLeft: boolean;
  canScrollRight: boolean;
  scrollTabs: (direction: 'left' | 'right') => void;
}

export function useChat(isOpen: boolean): UseChatReturn {
  const [chats, setChats] = useState<Chat[]>(() => loadChats());
  const [activeChatId, setActiveChatIdState] = useState<string | null>(() => loadActiveChatId());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const hasInitializedRef = useRef(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const setActiveChatId = useCallback((id: string | null) => {
    setActiveChatIdState(id);
  }, []);

  // Persist chats to localStorage
  useEffect(() => {
    saveChats(chats);
  }, [chats]);

  // Persist active chat ID
  useEffect(() => {
    saveActiveChatId(activeChatId);
  }, [activeChatId]);

  // Create initial chat when component is ready and no saved chats exist
  useEffect(() => {
    if (isOpen && chats.length === 0 && !activeChatId && !hasInitializedRef.current) {
      hasInitializedRef.current = true;
      const newChat: Chat = {
        id: Date.now().toString(),
        title: 'Chat 1',
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [],
        hasSentFirstMessage: false,
      };
      setChats(prev => [...prev, newChat]);
      setActiveChatIdState(newChat.id);
    }
    if (isOpen && chats.length > 0) {
      hasInitializedRef.current = true;
    }
  }, [isOpen, chats.length, activeChatId]);

  // Scroll to bottom on messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chats, activeChatId]);

  // Check scroll position for tabs
  const checkScrollButtons = useCallback(() => {
    const container = tabsContainerRef.current;
    if (!container) return;
    setCanScrollLeft(container.scrollLeft > 0);
    setCanScrollRight(
      container.scrollLeft < container.scrollWidth - container.clientWidth - 1
    );
  }, []);

  // Check scroll buttons on mount and when chats change
  useEffect(() => {
    checkScrollButtons();
    const container = tabsContainerRef.current;
    if (container) {
      container.addEventListener('scroll', checkScrollButtons);
      window.addEventListener('resize', checkScrollButtons);
      return () => {
        container.removeEventListener('scroll', checkScrollButtons);
        window.removeEventListener('resize', checkScrollButtons);
      };
    }
  }, [chats, checkScrollButtons]);

  // Auto-scroll to active tab
  useEffect(() => {
    if (!activeChatId || !tabsContainerRef.current) return;
    const container = tabsContainerRef.current;
    const activeTab = container.querySelector(`[data-chat-id="${activeChatId}"]`) as HTMLElement;
    if (activeTab) {
      const containerRect = container.getBoundingClientRect();
      const tabRect = activeTab.getBoundingClientRect();
      if (tabRect.left < containerRect.left) {
        container.scrollTo({ left: activeTab.offsetLeft - 20, behavior: 'smooth' });
      } else if (tabRect.right > containerRect.right) {
        container.scrollTo({
          left: activeTab.offsetLeft + activeTab.offsetWidth - container.clientWidth + 20,
          behavior: 'smooth',
        });
      }
    }
  }, [activeChatId]);

  const scrollTabs = useCallback((direction: 'left' | 'right') => {
    const container = tabsContainerRef.current;
    if (!container) return;
    const scrollAmount = 200;
    const scrollTo = direction === 'left'
      ? container.scrollLeft - scrollAmount
      : container.scrollLeft + scrollAmount;
    container.scrollTo({ left: scrollTo, behavior: 'smooth' });
  }, []);

  const handleCreateChat = useCallback((): string => {
    const newChat: Chat = {
      id: Date.now().toString(),
      title: `Chat ${chats.length + 1}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      hasSentFirstMessage: false,
    };
    setChats(prev => [...prev, newChat]);
    setActiveChatIdState(newChat.id);
    return newChat.id;
  }, [chats.length]);

  const handleDeleteChat = useCallback((chatId: string) => {
    setChats(prev => {
      const remaining = prev.filter(chat => chat.id !== chatId);
      if (activeChatId === chatId) {
        setActiveChatIdState(remaining.length > 0 ? remaining[0].id : null);
      }
      return remaining;
    });
  }, [activeChatId]);

  const handleClearHistory = useCallback(() => {
    clearChatHistory();
    setChats([]);
    setActiveChatIdState(null);
    hasInitializedRef.current = false;
  }, []);

  const activeChat = chats.find(c => c.id === activeChatId);

  return {
    chats,
    setChats,
    activeChatId,
    setActiveChatId,
    activeChat,
    handleCreateChat,
    handleDeleteChat,
    handleClearHistory,
    messagesEndRef,
    tabsContainerRef,
    canScrollLeft,
    canScrollRight,
    scrollTabs,
  };
}
