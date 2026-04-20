/* global SillyTavern */
/* global jQuery */
import { useEffect, useRef, useState } from 'react';
import _ from 'lodash';
import { Tab, Tabs, TabList, TabPanel } from 'react-tabs';
import 'react-tabs/style/react-tabs.css';
import Page from './Page';
import { importFromUrl } from './util.js';

/**
 * @typedef {object} Page
 * @property {string} title - The title of the page
 * @property {string} content - The content of the page
 */

/**
 * @typedef {'character' | 'global'} NotesMode
 */

/**
 * @typedef {'card' | 'chat'} CharacterNotesScope
 */

const dragElement = await importFromUrl('/scripts/RossAscends-mods.js', 'dragElement', () => { });
const NOTEBOOK_PLUS_PAGES_PATH = ['extensionSettings', 'notebookPlus', 'pages'];
const NOTEBOOK_PLUS_CHARACTER_PAGES_PATH = ['extensionSettings', 'notebookPlus', 'characterPages'];
const LEGACY_NOTEBOOK_PAGES_PATH = 'extensionSettings.notebook.pages';
const CHARACTER_PAGES_GENERAL_KEY = '__generalPages';
const CHARACTER_PAGES_CHATS_KEY = '__chatPages';
const CHARACTER_PAGES_INTEGRITY_KEY = '__chatPagesByIntegrity';
const NOTES_MODE = {
    CHARACTER: 'character',
    GLOBAL: 'global',
};
const CHARACTER_NOTES_SCOPE = {
    CARD: 'card',
    CHAT: 'chat',
};

function clampSelectedIndex(index, pageCount) {
    return pageCount <= 0 ? 0 : Math.min(index, pageCount - 1);
}

function getPagesForScope(notesMode, characterNotesScope, contextInfo, selectedCharacterChatId) {
    return notesMode === NOTES_MODE.CHARACTER
        ? StateManager.getCharacterPages(
            contextInfo.characterKey,
            characterNotesScope,
            selectedCharacterChatId,
            contextInfo.selectedChatIntegrityId ?? '',
        )
        : StateManager.getGlobalPages();
}

function getActiveScopeKey(notesMode, characterNotesScope, contextInfo, selectedCharacterChatId) {
    if (notesMode === NOTES_MODE.GLOBAL) {
        return NOTES_MODE.GLOBAL;
    }

    if (characterNotesScope === CHARACTER_NOTES_SCOPE.CARD) {
        return `${NOTES_MODE.CHARACTER}:${CHARACTER_NOTES_SCOPE.CARD}:${contextInfo.characterKey}`;
    }

    return `${NOTES_MODE.CHARACTER}:${CHARACTER_NOTES_SCOPE.CHAT}:${contextInfo.characterKey}:${selectedCharacterChatId}`;
}

function getNotebookContextSnapshot() {
    const context = SillyTavern.getContext();
    const isSingleCharacterChat = !context.groupId && context.characterId !== undefined;
    const character = isSingleCharacterChat ? context.characters[context.characterId] : null;

    return {
        characterId: isSingleCharacterChat ? context.characterId : null,
        characterKey: character?.avatar ?? '',
        characterName: character?.name ?? '',
        currentChatId: isSingleCharacterChat ? context.chatId ?? '' : '',
        currentChatIntegrityId: isSingleCharacterChat ? context.chatMetadata?.integrity ?? '' : '',
        selectedChatIntegrityId: '',
    };
}

function generateChatIntegrityId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `notebook-plus-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fetchCharacterChats(characterKey, currentChatId, currentChatIntegrityId = '') {
    if (!characterKey) {
        return [];
    }

    const context = SillyTavern.getContext();

    try {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: characterKey }),
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch chats for ${characterKey}`);
        }

        const chatMap = await response.json();
        return Object.values(chatMap)
            .map((chat) => {
                const chatId = chat?.file_name?.replace(/\.jsonl$/, '');

                if (!chatId) {
                    return null;
                }

                return {
                    id: chatId,
                    title: chatId,
                    integrityId: chatId === currentChatId ? currentChatIntegrityId : '',
                };
            })
            .filter(Boolean)
            .sort((left, right) => {
                if (left.id === currentChatId) {
                    return -1;
                }

                if (right.id === currentChatId) {
                    return 1;
                }

                return left.title.localeCompare(right.title);
            });
    } catch (error) {
        console.error('Failed to load character chats for Notebook-Plus', error);
        return [];
    }
}

async function fetchCharacterChatFile(characterKey, chatId) {
    if (!characterKey || !chatId) {
        return [];
    }

    const context = SillyTavern.getContext();
    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify({
            file_name: chatId,
            avatar_url: characterKey,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch chat file ${chatId}`);
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

async function saveCharacterChatFile(characterKey, chatId, chatData) {
    const context = SillyTavern.getContext();
    const response = await fetch('/api/chats/save', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            avatar_url: characterKey,
            file_name: chatId,
            chat: chatData,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to save chat file ${chatId}`);
    }
}

async function ensureCharacterChatIntegrity(characterKey, chatId) {
    const chatData = await fetchCharacterChatFile(characterKey, chatId);

    if (chatData.length === 0) {
        return '';
    }

    const chatHeader = _.isPlainObject(chatData[0]) ? chatData[0] : {};
    const chatMetadata = _.isPlainObject(chatHeader.chat_metadata) ? chatHeader.chat_metadata : {};

    if (chatMetadata.integrity) {
        return chatMetadata.integrity;
    }

    const integrityId = generateChatIntegrityId();
    chatData[0] = {
        ...chatHeader,
        chat_metadata: {
            ...chatMetadata,
            integrity: integrityId,
        },
        user_name: chatHeader.user_name ?? 'unused',
        character_name: chatHeader.character_name ?? 'unused',
    };

    await saveCharacterChatFile(characterKey, chatId, chatData);
    return integrityId;
}

function normalizeCharacterPagesBucket(bucket) {
    if (!_.isPlainObject(bucket)) {
        return {
            [CHARACTER_PAGES_GENERAL_KEY]: [],
            [CHARACTER_PAGES_CHATS_KEY]: {},
            [CHARACTER_PAGES_INTEGRITY_KEY]: {},
        };
    }

    if (
        Array.isArray(bucket[CHARACTER_PAGES_GENERAL_KEY])
        || _.isPlainObject(bucket[CHARACTER_PAGES_CHATS_KEY])
        || _.isPlainObject(bucket[CHARACTER_PAGES_INTEGRITY_KEY])
    ) {
        const chatPages = _.isPlainObject(bucket[CHARACTER_PAGES_CHATS_KEY])
            ? Object.entries(bucket[CHARACTER_PAGES_CHATS_KEY]).reduce((pagesByChat, [chatId, pages]) => {
                if (Array.isArray(pages)) {
                    pagesByChat[chatId] = pages;
                }

                return pagesByChat;
            }, {})
            : {};
        const integrityPages = _.isPlainObject(bucket[CHARACTER_PAGES_INTEGRITY_KEY])
            ? Object.entries(bucket[CHARACTER_PAGES_INTEGRITY_KEY]).reduce((pagesByIntegrity, [integrityId, pages]) => {
                if (Array.isArray(pages)) {
                    pagesByIntegrity[integrityId] = pages;
                }

                return pagesByIntegrity;
            }, {})
            : {};

        return {
            [CHARACTER_PAGES_GENERAL_KEY]: Array.isArray(bucket[CHARACTER_PAGES_GENERAL_KEY]) ? bucket[CHARACTER_PAGES_GENERAL_KEY] : [],
            [CHARACTER_PAGES_CHATS_KEY]: chatPages,
            [CHARACTER_PAGES_INTEGRITY_KEY]: integrityPages,
        };
    }

    const legacyChatPages = Object.entries(bucket).reduce((pagesByChat, [chatId, pages]) => {
        if (Array.isArray(pages)) {
            pagesByChat[chatId] = pages;
        }

        return pagesByChat;
    }, {});

    return {
        [CHARACTER_PAGES_GENERAL_KEY]: [],
        [CHARACTER_PAGES_CHATS_KEY]: legacyChatPages,
        [CHARACTER_PAGES_INTEGRITY_KEY]: {},
    };
}

function getCharacterDropdownPlaceholder(notesMode, characterNotesScope, characterName) {
    if (notesMode === NOTES_MODE.GLOBAL) {
        return 'Character notes disabled in Global mode';
    }

    if (characterNotesScope === CHARACTER_NOTES_SCOPE.CARD) {
        return 'Specific chat selector disabled for card-wide notes';
    }

    if (characterName) {
        return `No chats found for ${characterName}`;
    }

    return 'Open a character chat to use Character Notes';
}

function getEmptyStateMessage(notesMode, characterNotesScope, contextInfo, selectedCharacterChatId) {
    if (notesMode === NOTES_MODE.CHARACTER) {
        if (!contextInfo.characterKey) {
            return 'Open a character chat to use Character Notes.';
        }

        if (characterNotesScope === CHARACTER_NOTES_SCOPE.CARD) {
            return 'Click the + button to add a note for this character card.';
        }

        if (!selectedCharacterChatId) {
            return 'No chat files are available for this character card.';
        }

        return 'Click the + button to add a note for this chat.';
    }

    return 'Click the + button to add a note.';
}

/**
 * Persistent state manager for Notebook-Plus.
 */
class StateManager {
    /**
     * Get the list of global pages in Notebook-Plus from extension settings.
     * @returns {Page[]} List of pages
     */
    static getGlobalPages() {
        const context = SillyTavern.getContext();
        const pages = _.get(context, NOTEBOOK_PLUS_PAGES_PATH);

        if (Array.isArray(pages)) {
            return pages;
        }

        const legacyPages = _.get(context, LEGACY_NOTEBOOK_PAGES_PATH);

        if (Array.isArray(legacyPages) && legacyPages.length > 0) {
            const migratedPages = _.cloneDeep(legacyPages);
            _.set(context, NOTEBOOK_PLUS_PAGES_PATH, migratedPages);
            context.saveSettingsDebounced();
            return migratedPages;
        }

        return [];
    }

    /**
     * Set the list of global pages in Notebook-Plus to extension settings.
     * @param {Page[]} pages List of pages to set
     */
    static setGlobalPages(pages) {
        const context = SillyTavern.getContext();
        _.set(context, NOTEBOOK_PLUS_PAGES_PATH, pages);
        context.saveSettingsDebounced();
    }

    /**
     * Get the list of character pages in Notebook-Plus from extension settings.
     * @param {string} characterKey Character avatar key
     * @param {CharacterNotesScope} characterNotesScope Character note scope
     * @param {string} chatId Chat file name without extension
     * @returns {Page[]} List of pages
     */
    static getCharacterPages(characterKey, characterNotesScope, chatId = '', chatIntegrityId = '') {
        if (!characterKey) {
            return [];
        }

        const context = SillyTavern.getContext();
        const bucket = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey]));

        if (characterNotesScope === CHARACTER_NOTES_SCOPE.CARD) {
            return bucket[CHARACTER_PAGES_GENERAL_KEY];
        }

        if (chatIntegrityId && Array.isArray(bucket[CHARACTER_PAGES_INTEGRITY_KEY][chatIntegrityId])) {
            return bucket[CHARACTER_PAGES_INTEGRITY_KEY][chatIntegrityId];
        }

        return Array.isArray(bucket[CHARACTER_PAGES_CHATS_KEY][chatId]) ? bucket[CHARACTER_PAGES_CHATS_KEY][chatId] : [];
    }

    /**
     * Set the list of character pages in Notebook-Plus to extension settings.
     * @param {string} characterKey Character avatar key
     * @param {CharacterNotesScope} characterNotesScope Character note scope
     * @param {string} chatId Chat file name without extension
     * @param {Page[]} pages List of pages to set
     */
    static setCharacterPages(characterKey, characterNotesScope, chatId, chatIntegrityId, pages) {
        if (!characterKey) {
            return;
        }

        const context = SillyTavern.getContext();
        const bucket = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey]));

        if (characterNotesScope === CHARACTER_NOTES_SCOPE.CARD) {
            bucket[CHARACTER_PAGES_GENERAL_KEY] = pages;
        } else if (chatIntegrityId) {
            bucket[CHARACTER_PAGES_INTEGRITY_KEY][chatIntegrityId] = pages;

            if (chatId) {
                delete bucket[CHARACTER_PAGES_CHATS_KEY][chatId];
            }
        } else if (chatId) {
            bucket[CHARACTER_PAGES_CHATS_KEY][chatId] = pages;
        } else {
            return;
        }

        _.set(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey], bucket);
        context.saveSettingsDebounced();
    }

    /**
     * Migrate filename-keyed chat notes into integrity-keyed storage.
     * @param {string} characterKey Character avatar key
     * @param {string} chatId Chat file name without extension
     * @param {string} chatIntegrityId Stable chat integrity identifier
     */
    static migrateCharacterChatPages(characterKey, chatId, chatIntegrityId) {
        if (!characterKey || !chatId || !chatIntegrityId) {
            return;
        }

        const context = SillyTavern.getContext();
        const bucket = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey]));
        const legacyPages = bucket[CHARACTER_PAGES_CHATS_KEY][chatId];
        const integrityPages = bucket[CHARACTER_PAGES_INTEGRITY_KEY][chatIntegrityId];

        if (!Array.isArray(legacyPages) || Array.isArray(integrityPages)) {
            return;
        }

        bucket[CHARACTER_PAGES_INTEGRITY_KEY][chatIntegrityId] = legacyPages;
        delete bucket[CHARACTER_PAGES_CHATS_KEY][chatId];
        _.set(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey], bucket);
        context.saveSettingsDebounced();
    }

    /**
     * Move per-character notes when SillyTavern renames a character avatar key.
     * @param {string} oldCharacterKey Previous character avatar key
     * @param {string} newCharacterKey New character avatar key
     */
    static renameCharacterPages(oldCharacterKey, newCharacterKey) {
        if (!oldCharacterKey || !newCharacterKey || oldCharacterKey === newCharacterKey) {
            return;
        }

        const context = SillyTavern.getContext();
        const previousPages = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, oldCharacterKey]));

        if (
            previousPages[CHARACTER_PAGES_GENERAL_KEY].length === 0
            && Object.keys(previousPages[CHARACTER_PAGES_CHATS_KEY]).length === 0
            && Object.keys(previousPages[CHARACTER_PAGES_INTEGRITY_KEY]).length === 0
        ) {
            return;
        }

        const currentPages = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, newCharacterKey]));
        const mergedPages = {
            [CHARACTER_PAGES_GENERAL_KEY]: currentPages[CHARACTER_PAGES_GENERAL_KEY].length > 0
                ? currentPages[CHARACTER_PAGES_GENERAL_KEY]
                : previousPages[CHARACTER_PAGES_GENERAL_KEY],
            [CHARACTER_PAGES_CHATS_KEY]: {
                ...previousPages[CHARACTER_PAGES_CHATS_KEY],
                ...currentPages[CHARACTER_PAGES_CHATS_KEY],
            },
            [CHARACTER_PAGES_INTEGRITY_KEY]: {
                ...previousPages[CHARACTER_PAGES_INTEGRITY_KEY],
                ...currentPages[CHARACTER_PAGES_INTEGRITY_KEY],
            },
        };

        _.set(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, newCharacterKey], mergedPages);
        _.unset(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, oldCharacterKey]);
        context.saveSettingsDebounced();
    }
}

function App({ onCloseClicked }) {
    const [pages, setPages] = useState(StateManager.getGlobalPages());
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [notesMode, setNotesMode] = useState(NOTES_MODE.GLOBAL);
    const [characterNotesScope, setCharacterNotesScope] = useState(CHARACTER_NOTES_SCOPE.CHAT);
    const [contextInfo, setContextInfo] = useState(() => getNotebookContextSnapshot());
    const [characterChats, setCharacterChats] = useState([]);
    const [selectedCharacterChatId, setSelectedCharacterChatId] = useState(() => getNotebookContextSnapshot().currentChatId);
    const [selectedCharacterChatIntegrityId, setSelectedCharacterChatIntegrityId] = useState(() => getNotebookContextSnapshot().currentChatIntegrityId);
    const refreshRequestRef = useRef(0);
    const contextInfoRef = useRef(contextInfo);
    const selectedCharacterChatIdRef = useRef(selectedCharacterChatId);
    const chatIntegrityCacheRef = useRef(new Map());

    useEffect(() => {
        contextInfoRef.current = contextInfo;
    }, [contextInfo]);

    useEffect(() => {
        selectedCharacterChatIdRef.current = selectedCharacterChatId;
    }, [selectedCharacterChatId]);

    function getChatCacheKey(characterKey, chatId) {
        return `${characterKey}:${chatId}`;
    }

    function setCachedChatIntegrity(characterKey, chatId, integrityId) {
        if (!characterKey || !chatId || !integrityId) {
            return;
        }

        chatIntegrityCacheRef.current.set(getChatCacheKey(characterKey, chatId), integrityId);
    }

    function getCachedChatIntegrity(characterKey, chatId) {
        if (!characterKey || !chatId) {
            return '';
        }

        return chatIntegrityCacheRef.current.get(getChatCacheKey(characterKey, chatId)) ?? '';
    }

    function syncCharacterChatIntegrity(characterKey, chatId, integrityId) {
        if (!chatId || !integrityId) {
            return;
        }

        setCachedChatIntegrity(characterKey, chatId, integrityId);
        setCharacterChats((currentChats) => currentChats.map((chat) => (
            chat.id === chatId ? { ...chat, integrityId } : chat
        )));
    }

    async function resolveCharacterChatIntegrity(characterKey, chatId, options = {}) {
        const {
            currentChatId = '',
            currentChatIntegrityId = '',
        } = options;

        if (!characterKey || !chatId) {
            return '';
        }

        const cachedIntegrityId = getCachedChatIntegrity(characterKey, chatId)
            || characterChats.find((chat) => chat.id === chatId)?.integrityId
            || '';

        if (cachedIntegrityId) {
            return cachedIntegrityId;
        }

        if (chatId === currentChatId && currentChatIntegrityId) {
            syncCharacterChatIntegrity(characterKey, chatId, currentChatIntegrityId);
            return currentChatIntegrityId;
        }

        const integrityId = await ensureCharacterChatIntegrity(characterKey, chatId);

        if (integrityId) {
            syncCharacterChatIntegrity(characterKey, chatId, integrityId);
        }

        return integrityId;
    }

    useEffect(() => {
        dragElement(jQuery(document.getElementById('notebookPlusPanel')));
        const context = SillyTavern.getContext();

        async function refreshContextAndChats(options = {}) {
            const { preserveSelectedChat = false } = options;
            const snapshot = getNotebookContextSnapshot();
            const previousContextInfo = contextInfoRef.current;
            const requestId = ++refreshRequestRef.current;

            setContextInfo(snapshot);

            if (!snapshot.characterKey) {
                setCharacterChats([]);
                setSelectedCharacterChatId('');
                setSelectedCharacterChatIntegrityId('');
                return;
            }

            const chats = await fetchCharacterChats(snapshot.characterKey, snapshot.currentChatId, snapshot.currentChatIntegrityId);

            if (requestId !== refreshRequestRef.current) {
                return;
            }

            setCharacterChats(chats);

            if (snapshot.currentChatId && snapshot.currentChatIntegrityId) {
                setCachedChatIntegrity(snapshot.characterKey, snapshot.currentChatId, snapshot.currentChatIntegrityId);
            }

            const shouldKeepSelectedChat = preserveSelectedChat && previousContextInfo.characterKey === snapshot.characterKey;
            const preferredChatId = shouldKeepSelectedChat ? selectedCharacterChatIdRef.current : snapshot.currentChatId;
            const nextSelectedChatId = chats.some((chat) => chat.id === preferredChatId)
                ? preferredChatId
                : chats[0]?.id ?? '';
            const nextSelectedChatIntegrityId = chats.find((chat) => chat.id === nextSelectedChatId)?.integrityId
                ?? (nextSelectedChatId === snapshot.currentChatId ? snapshot.currentChatIntegrityId : '');

            setSelectedCharacterChatId(nextSelectedChatId);
            setSelectedCharacterChatIntegrityId(nextSelectedChatIntegrityId);
        }

        const syncScopeToCurrentChat = () => {
            void refreshContextAndChats();
        };

        const preserveScopeSelection = () => {
            void refreshContextAndChats({ preserveSelectedChat: true });
        };

        const renameCharacterPages = (oldCharacterKey, newCharacterKey) => {
            StateManager.renameCharacterPages(oldCharacterKey, newCharacterKey);
            void refreshContextAndChats({ preserveSelectedChat: true });
        };

        void refreshContextAndChats();

        context.eventSource.on(context.eventTypes.CHAT_CHANGED, syncScopeToCurrentChat);
        context.eventSource.on(context.eventTypes.CHARACTER_PAGE_LOADED, syncScopeToCurrentChat);
        context.eventSource.on(context.eventTypes.GROUP_UPDATED, syncScopeToCurrentChat);
        context.eventSource.on(context.eventTypes.CHARACTER_EDITED, preserveScopeSelection);
        context.eventSource.on(context.eventTypes.CHARACTER_RENAMED, renameCharacterPages);

        return () => {
            refreshRequestRef.current += 1;
            context.eventSource.removeListener(context.eventTypes.CHAT_CHANGED, syncScopeToCurrentChat);
            context.eventSource.removeListener(context.eventTypes.CHARACTER_PAGE_LOADED, syncScopeToCurrentChat);
            context.eventSource.removeListener(context.eventTypes.GROUP_UPDATED, syncScopeToCurrentChat);
            context.eventSource.removeListener(context.eventTypes.CHARACTER_EDITED, preserveScopeSelection);
            context.eventSource.removeListener(context.eventTypes.CHARACTER_RENAMED, renameCharacterPages);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;

        if (
            notesMode !== NOTES_MODE.CHARACTER
            || characterNotesScope !== CHARACTER_NOTES_SCOPE.CHAT
            || !contextInfo.characterKey
            || !selectedCharacterChatId
        ) {
            setSelectedCharacterChatIntegrityId('');
            return undefined;
        }

        const knownIntegrityId = getCachedChatIntegrity(contextInfo.characterKey, selectedCharacterChatId)
            || characterChats.find((chat) => chat.id === selectedCharacterChatId)?.integrityId
            || (selectedCharacterChatId === contextInfo.currentChatId ? contextInfo.currentChatIntegrityId : '');

        setSelectedCharacterChatIntegrityId(knownIntegrityId);

        async function resolveIntegrity() {
            const resolvedIntegrityId = await resolveCharacterChatIntegrity(contextInfo.characterKey, selectedCharacterChatId, {
                currentChatId: contextInfo.currentChatId,
                currentChatIntegrityId: contextInfo.currentChatIntegrityId,
            });

            if (cancelled) {
                return;
            }

            if (resolvedIntegrityId) {
                StateManager.migrateCharacterChatPages(contextInfo.characterKey, selectedCharacterChatId, resolvedIntegrityId);
            }

            setSelectedCharacterChatIntegrityId(resolvedIntegrityId);
        }

        void resolveIntegrity();

        return () => {
            cancelled = true;
        };
    }, [
        notesMode,
        characterNotesScope,
        contextInfo.characterKey,
        contextInfo.currentChatId,
        contextInfo.currentChatIntegrityId,
        selectedCharacterChatId,
        characterChats,
    ]);

    useEffect(() => {
        const nextPages = getPagesForScope(
            notesMode,
            characterNotesScope,
            {
                ...contextInfo,
                selectedChatIntegrityId: selectedCharacterChatIntegrityId,
            },
            selectedCharacterChatId,
        );

        setPages(nextPages);
        setSelectedIndex((index) => clampSelectedIndex(index, nextPages.length));
    }, [notesMode, characterNotesScope, contextInfo.characterKey, selectedCharacterChatId, selectedCharacterChatIntegrityId]);

    function persistPages(nextPages) {
        if (notesMode === NOTES_MODE.CHARACTER) {
            StateManager.setCharacterPages(
                contextInfo.characterKey,
                characterNotesScope,
                selectedCharacterChatId,
                selectedCharacterChatIntegrityId,
                nextPages,
            );
            return;
        }

        StateManager.setGlobalPages(nextPages);
    }

    function switchToScope(nextNotesMode, nextCharacterNotesScope = characterNotesScope, nextSelectedCharacterChatId = selectedCharacterChatId) {
        const nextSelectedCharacterChatIntegrityId = getCachedChatIntegrity(contextInfo.characterKey, nextSelectedCharacterChatId)
            || characterChats.find((chat) => chat.id === nextSelectedCharacterChatId)?.integrityId
            || (nextSelectedCharacterChatId === contextInfo.currentChatId ? contextInfo.currentChatIntegrityId : '');
        const nextPages = getPagesForScope(
            nextNotesMode,
            nextCharacterNotesScope,
            {
                ...contextInfo,
                selectedChatIntegrityId: nextSelectedCharacterChatIntegrityId,
            },
            nextSelectedCharacterChatId,
        );

        setNotesMode(nextNotesMode);
        setCharacterNotesScope(nextCharacterNotesScope);
        setSelectedCharacterChatId(nextSelectedCharacterChatId);
        setSelectedCharacterChatIntegrityId(nextSelectedCharacterChatIntegrityId);
        setPages(nextPages);
        setSelectedIndex((index) => clampSelectedIndex(index, nextPages.length));
    }

    function handleChange(index, page) {
        const nextPages = [...pages];

        if (!page) {
            nextPages.splice(index, 1);
            setSelectedIndex((currentIndex) => clampSelectedIndex(currentIndex, nextPages.length));
        } else {
            nextPages[index] = page;
        }

        setPages(nextPages);
        persistPages(nextPages);
    }

    function addPage() {
        if (!canEditCurrentScope) {
            return;
        }

        const nextPages = [...pages, { title: 'Untitled', content: '' }];
        setPages(nextPages);
        setSelectedIndex(nextPages.length - 1);
        persistPages(nextPages);
    }

    function handleTabSelect(index) {
        if (index === pages.length) {
            addPage();
            return false;
        }

        setSelectedIndex(index);
        return true;
    }

    function sliceTitle(title) {
        return title && title.length > 10 ? `${title.slice(0, 10)}...` : title;
    }

    const characterDropdownDisabled = notesMode !== NOTES_MODE.CHARACTER || characterNotesScope === CHARACTER_NOTES_SCOPE.CARD || characterChats.length === 0;
    const canEditCurrentScope = notesMode === NOTES_MODE.GLOBAL
        || Boolean(contextInfo.characterKey && (characterNotesScope === CHARACTER_NOTES_SCOPE.CARD || selectedCharacterChatId));
    const selectedDropdownValue = !characterDropdownDisabled && characterChats.some((chat) => chat.id === selectedCharacterChatId)
        ? selectedCharacterChatId
        : '';
    const activeScopeKey = getActiveScopeKey(
        notesMode,
        characterNotesScope,
        contextInfo,
        selectedCharacterChatIntegrityId || selectedCharacterChatId,
    );
    const emptyStateMessage = getEmptyStateMessage(notesMode, characterNotesScope, contextInfo, selectedCharacterChatId);
    const characterDropdownPlaceholder = getCharacterDropdownPlaceholder(notesMode, characterNotesScope, contextInfo.characterName);

    return (
        <>
            <div className="panelControlBar flex-container alignItemsBaseline">
                <div id="notebookPlusPanelheader" className="fa-fw fa-solid fa-grip drag-grabber"></div>
                <div id="notebookPlusPanelMaximize" className="inline-drawer-maximize">
                    <i className="floating_panel_maximize fa-fw fa-solid fa-window-maximize"></i>
                </div>
                <div id="notebookPlusPanelClose" className="fa-fw fa-solid fa-circle-xmark floating_panel_close" onClick={() => onCloseClicked()}></div>
            </div>
            <div id="notebookPlusPanelHolder" name="notebookPlusPanelHolder" className="scrollY">
                <div className="notebookPlusScopeControls">
                    <div className="notebookPlusScopeToggle" role="tablist" aria-label="Notebook scope">
                        <button
                            type="button"
                            className={`notebookPlusScopeButton notebookPlusScopeButton--character ${notesMode === NOTES_MODE.CHARACTER ? 'is-active' : ''}`}
                            onClick={() => switchToScope(NOTES_MODE.CHARACTER)}
                        >
                            Character Notes
                        </button>
                        <button
                            type="button"
                            className={`notebookPlusScopeButton notebookPlusScopeButton--global ${notesMode === NOTES_MODE.GLOBAL ? 'is-active' : ''}`}
                            onClick={() => switchToScope(NOTES_MODE.GLOBAL)}
                        >
                            Global
                        </button>
                    </div>
                    {notesMode === NOTES_MODE.CHARACTER && (
                        <div className="notebookPlusScopeField">
                            <div className="notebookPlusScopeLabel">Character note scope</div>
                            <select
                                className="text_pole notebookPlusChatSelect"
                                value={characterNotesScope}
                                onChange={(event) => switchToScope(NOTES_MODE.CHARACTER, event.target.value, selectedCharacterChatId)}
                            >
                                <option value={CHARACTER_NOTES_SCOPE.CARD}>In general for this card</option>
                                <option value={CHARACTER_NOTES_SCOPE.CHAT}>Specific chat on this card</option>
                            </select>
                        </div>
                    )}
                    <div className="notebookPlusScopeField">
                        <div className="notebookPlusScopeLabel">Chat file</div>
                        <select
                            className="text_pole notebookPlusChatSelect"
                            value={selectedDropdownValue}
                            onChange={(event) => switchToScope(NOTES_MODE.CHARACTER, characterNotesScope, event.target.value)}
                            disabled={characterDropdownDisabled}
                        >
                            {characterDropdownDisabled ? (
                                <option value="">{characterDropdownPlaceholder}</option>
                            ) : (
                                characterChats.map((chat) => (
                                    <option key={chat.id} value={chat.id}>{chat.title}</option>
                                ))
                            )}
                        </select>
                    </div>
                </div>
                <Tabs key={activeScopeKey} selectedIndex={selectedIndex} onSelect={handleTabSelect}>
                    <TabList>
                        {pages.map((page, index) => (
                            <Tab key={`${activeScopeKey}:${index}`}>{sliceTitle(page.title) || '[No name]'}</Tab>
                        ))}
                        <Tab title="Add a note" disabled={!canEditCurrentScope}>
                            <i className="fa-solid fa-plus"></i>
                        </Tab>
                    </TabList>
                    {pages.map((page, index) => (
                        <TabPanel key={`${activeScopeKey}:panel:${index}`}>
                            <Page page={page} onChange={(newPage) => handleChange(index, newPage)} />
                        </TabPanel>
                    ))}
                    <TabPanel>
                    </TabPanel>
                    {pages.length === 0 && (
                        <div className="flex-container flexFlowColumn alignItemsCenter">
                            <h3>{emptyStateMessage}</h3>
                        </div>
                    )}
                </Tabs>
            </div>
        </>
    );
}

export default App;
