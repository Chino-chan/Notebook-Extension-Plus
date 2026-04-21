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
const CHARACTER_PAGES_STORAGE_KEYS_KEY = '__chatStorageKeysByFilename';
const NOTEBOOK_PLUS_CHAT_METADATA_KEY = 'notebookPlusChatKey';
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
            contextInfo.selectedChatStorageKey ?? '',
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
        currentChatStorageKey: isSingleCharacterChat ? context.chatMetadata?.[NOTEBOOK_PLUS_CHAT_METADATA_KEY] ?? '' : '',
        currentChatMainChat: isSingleCharacterChat ? context.chatMetadata?.main_chat ?? '' : '',
        selectedChatStorageKey: '',
    };
}

function isDerivedChatFilename(chatId) {
    if (!chatId) {
        return false;
    }

    return / - Branch #\d+$/i.test(chatId) || / - Checkpoint #\d+$/i.test(chatId);
}

function isDerivedChatMetadata(chatId, chatMetadata) {
    if (!chatId || !_.isPlainObject(chatMetadata) || typeof chatMetadata.main_chat !== 'string' || !chatMetadata.main_chat) {
        return false;
    }

    return chatMetadata.main_chat !== chatId;
}

function generateChatIntegrityId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `notebook-plus-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fetchCharacterChats(characterKey, currentChatId, currentChatStorageKey = '') {
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
                    storageKey: chatId === currentChatId ? currentChatStorageKey : '',
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

function buildChatHeader(chatHeader, chatMetadata) {
    return {
        ...chatHeader,
        chat_metadata: chatMetadata,
        user_name: chatHeader.user_name ?? 'unused',
        character_name: chatHeader.character_name ?? 'unused',
    };
}

function normalizeChatStorageKeysMap(storageKeysByFilename, activeChatIds = []) {
    const activeChatIdSet = new Set(activeChatIds.filter(Boolean));

    return Object.entries(_.isPlainObject(storageKeysByFilename) ? storageKeysByFilename : {}).reduce((resolvedMap, [chatId, storageKey]) => {
        if (typeof storageKey !== 'string' || !storageKey) {
            return resolvedMap;
        }

        if (activeChatIdSet.size > 0 && !activeChatIdSet.has(chatId)) {
            return resolvedMap;
        }

        resolvedMap[chatId] = storageKey;
        return resolvedMap;
    }, {});
}

async function ensureCharacterChatStorageKey(characterKey, chatId, options = {}) {
    const {
        currentChatId = '',
        currentChatMetadata = null,
        activeChatIds = [],
    } = options;

    let chatData = [];
    let chatHeader = {};
    let chatMetadata = {};
    const isCurrentChat = chatId === currentChatId && _.isPlainObject(currentChatMetadata);

    if (isCurrentChat) {
        chatMetadata = { ...currentChatMetadata };
    } else {
        chatData = await fetchCharacterChatFile(characterKey, chatId);

        if (chatData.length === 0) {
            return { storageKey: '', sourceKey: '' };
        }

        chatHeader = _.isPlainObject(chatData[0]) ? chatData[0] : {};
        chatMetadata = _.isPlainObject(chatHeader.chat_metadata) ? { ...chatHeader.chat_metadata } : {};
    }

    let didChangeMetadata = false;
    let didChangeBucket = false;
    const bucket = getCharacterPagesBucket(characterKey);
    const rawStorageKeysByFilename = _.isPlainObject(bucket[CHARACTER_PAGES_STORAGE_KEYS_KEY]) ? bucket[CHARACTER_PAGES_STORAGE_KEYS_KEY] : {};
    const normalizedStorageKeysByFilename = normalizeChatStorageKeysMap(rawStorageKeysByFilename, [...activeChatIds, chatId]);

    if (!_.isEqual(normalizedStorageKeysByFilename, bucket[CHARACTER_PAGES_STORAGE_KEYS_KEY])) {
        bucket[CHARACTER_PAGES_STORAGE_KEYS_KEY] = normalizedStorageKeysByFilename;
        didChangeBucket = true;
    }

    if (!chatMetadata.integrity) {
        chatMetadata.integrity = generateChatIntegrityId();
        didChangeMetadata = true;
    }

    const inheritedStorageKey = typeof chatMetadata[NOTEBOOK_PLUS_CHAT_METADATA_KEY] === 'string'
        ? chatMetadata[NOTEBOOK_PLUS_CHAT_METADATA_KEY]
        : '';
    const sourceKey = inheritedStorageKey || chatMetadata.integrity;
    let storageKey = normalizedStorageKeysByFilename[chatId] ?? '';
    const existingStorageKeyOwners = Object.entries(rawStorageKeysByFilename).filter(([mappedChatId, mappedStorageKey]) => (
        mappedChatId !== chatId
        && mappedStorageKey
        && mappedStorageKey === inheritedStorageKey
    ));
    const activeStorageKeyOwner = existingStorageKeyOwners.find(([mappedChatId]) => activeChatIds.includes(mappedChatId));
    const staleStorageKeyOwner = existingStorageKeyOwners.find(([mappedChatId]) => !activeChatIds.includes(mappedChatId));
    const derivedChat = isDerivedChatFilename(chatId) || isDerivedChatMetadata(chatId, chatMetadata);

    if (!storageKey) {
        if (derivedChat) {
            if (inheritedStorageKey && staleStorageKeyOwner && !activeStorageKeyOwner) {
                storageKey = inheritedStorageKey;
                delete bucket[CHARACTER_PAGES_STORAGE_KEYS_KEY][staleStorageKeyOwner[0]];
            } else {
                storageKey = generateChatIntegrityId();
                chatMetadata[NOTEBOOK_PLUS_CHAT_METADATA_KEY] = storageKey;
                didChangeMetadata = true;
            }
        } else {
            storageKey = inheritedStorageKey || chatMetadata.integrity;

            if (inheritedStorageKey && chatMetadata[NOTEBOOK_PLUS_CHAT_METADATA_KEY] !== inheritedStorageKey) {
                chatMetadata[NOTEBOOK_PLUS_CHAT_METADATA_KEY] = inheritedStorageKey;
                didChangeMetadata = true;
            }
        }

        bucket[CHARACTER_PAGES_STORAGE_KEYS_KEY][chatId] = storageKey;
        didChangeBucket = true;
    }

    if (chatMetadata[NOTEBOOK_PLUS_CHAT_METADATA_KEY] && chatMetadata[NOTEBOOK_PLUS_CHAT_METADATA_KEY] !== storageKey) {
        chatMetadata[NOTEBOOK_PLUS_CHAT_METADATA_KEY] = storageKey;
        didChangeMetadata = true;
    }

    if (didChangeMetadata) {
        if (isCurrentChat) {
            const context = SillyTavern.getContext();
            context.updateChatMetadata(chatMetadata, true);
            await context.saveMetadata();
        } else {
            chatData[0] = buildChatHeader(chatHeader, chatMetadata);
            await saveCharacterChatFile(characterKey, chatId, chatData);
        }
    }

    if (didChangeBucket) {
        saveCharacterPagesBucket(characterKey, bucket);
    }

    return { storageKey, sourceKey };
}

function normalizeCharacterPagesBucket(bucket) {
    if (!_.isPlainObject(bucket)) {
        return {
            [CHARACTER_PAGES_GENERAL_KEY]: [],
            [CHARACTER_PAGES_CHATS_KEY]: {},
            [CHARACTER_PAGES_INTEGRITY_KEY]: {},
            [CHARACTER_PAGES_STORAGE_KEYS_KEY]: {},
        };
    }

    if (
        Array.isArray(bucket[CHARACTER_PAGES_GENERAL_KEY])
        || _.isPlainObject(bucket[CHARACTER_PAGES_CHATS_KEY])
        || _.isPlainObject(bucket[CHARACTER_PAGES_INTEGRITY_KEY])
        || _.isPlainObject(bucket[CHARACTER_PAGES_STORAGE_KEYS_KEY])
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
        const storageKeysByFilename = normalizeChatStorageKeysMap(bucket[CHARACTER_PAGES_STORAGE_KEYS_KEY]);

        return {
            [CHARACTER_PAGES_GENERAL_KEY]: Array.isArray(bucket[CHARACTER_PAGES_GENERAL_KEY]) ? bucket[CHARACTER_PAGES_GENERAL_KEY] : [],
            [CHARACTER_PAGES_CHATS_KEY]: chatPages,
            [CHARACTER_PAGES_INTEGRITY_KEY]: integrityPages,
            [CHARACTER_PAGES_STORAGE_KEYS_KEY]: storageKeysByFilename,
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
        [CHARACTER_PAGES_STORAGE_KEYS_KEY]: {},
    };
}

function getCharacterPagesBucket(characterKey) {
    if (!characterKey) {
        return normalizeCharacterPagesBucket({});
    }

    const context = SillyTavern.getContext();
    return normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey]));
}

function saveCharacterPagesBucket(characterKey, bucket) {
    if (!characterKey) {
        return;
    }

    const context = SillyTavern.getContext();
    _.set(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey], bucket);
    context.saveSettingsDebounced();
}

function getPersistedChatStorageKey(characterKey, chatId) {
    if (!characterKey || !chatId) {
        return '';
    }

    const bucket = getCharacterPagesBucket(characterKey);
    return bucket[CHARACTER_PAGES_STORAGE_KEYS_KEY][chatId] ?? '';
}

function getSafeCurrentChatStorageKey(characterKey, chatId, currentChatId, currentChatStorageKey, currentChatMainChat = '') {
    if (!characterKey || !chatId || chatId !== currentChatId || !currentChatStorageKey) {
        return '';
    }

    const persistedStorageKey = getPersistedChatStorageKey(characterKey, chatId);
    const isDerivedCurrentChat = currentChatMainChat && currentChatMainChat !== chatId;

    if (persistedStorageKey || (!isDerivedChatFilename(chatId) && !isDerivedCurrentChat)) {
        return currentChatStorageKey;
    }

    return '';
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
    static migrateCharacterChatPages(characterKey, chatId, targetChatKey, sourceChatKey = '') {
        if (!characterKey || !chatId || !targetChatKey) {
            return;
        }

        const context = SillyTavern.getContext();
        const bucket = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey]));
        const legacyPages = bucket[CHARACTER_PAGES_CHATS_KEY][chatId];
        const targetPages = bucket[CHARACTER_PAGES_INTEGRITY_KEY][targetChatKey];
        const sourcePages = sourceChatKey ? bucket[CHARACTER_PAGES_INTEGRITY_KEY][sourceChatKey] : undefined;
        let didChange = false;

        if (!Array.isArray(targetPages) && Array.isArray(legacyPages)) {
            bucket[CHARACTER_PAGES_INTEGRITY_KEY][targetChatKey] = legacyPages;
            delete bucket[CHARACTER_PAGES_CHATS_KEY][chatId];
            didChange = true;
        }

        if (!Array.isArray(bucket[CHARACTER_PAGES_INTEGRITY_KEY][targetChatKey]) && Array.isArray(sourcePages)) {
            bucket[CHARACTER_PAGES_INTEGRITY_KEY][targetChatKey] = _.cloneDeep(sourcePages);
            didChange = true;
        }

        if (!didChange) {
            return;
        }

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
            && Object.keys(previousPages[CHARACTER_PAGES_STORAGE_KEYS_KEY]).length === 0
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
            [CHARACTER_PAGES_STORAGE_KEYS_KEY]: {
                ...previousPages[CHARACTER_PAGES_STORAGE_KEYS_KEY],
                ...currentPages[CHARACTER_PAGES_STORAGE_KEYS_KEY],
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
    const [selectedCharacterChatStorageKey, setSelectedCharacterChatStorageKey] = useState(() => getNotebookContextSnapshot().currentChatStorageKey);
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

    function setCachedChatStorageKey(characterKey, chatId, storageKey) {
        if (!characterKey || !chatId || !storageKey) {
            return;
        }

        chatIntegrityCacheRef.current.set(getChatCacheKey(characterKey, chatId), storageKey);
    }

    function getCachedChatStorageKey(characterKey, chatId) {
        if (!characterKey || !chatId) {
            return '';
        }

        return chatIntegrityCacheRef.current.get(getChatCacheKey(characterKey, chatId)) ?? '';
    }

    function syncCharacterChatStorageKey(characterKey, chatId, storageKey) {
        if (!chatId || !storageKey) {
            return;
        }

        setCachedChatStorageKey(characterKey, chatId, storageKey);
        setCharacterChats((currentChats) => currentChats.map((chat) => (
            chat.id === chatId ? { ...chat, storageKey } : chat
        )));
    }

    async function resolveCharacterChatStorageKey(characterKey, chatId, options = {}) {
        const {
            currentChatId = '',
            currentChatMetadata = null,
            activeChatIds = [],
        } = options;

        if (!characterKey || !chatId) {
            return '';
        }

        const cachedStorageKey = getCachedChatStorageKey(characterKey, chatId)
            || getPersistedChatStorageKey(characterKey, chatId)
            || '';

        if (cachedStorageKey) {
            return { storageKey: cachedStorageKey, sourceKey: '' };
        }

        const result = await ensureCharacterChatStorageKey(characterKey, chatId, {
            currentChatId,
            currentChatMetadata,
            activeChatIds,
        });

        if (result.storageKey) {
            syncCharacterChatStorageKey(characterKey, chatId, result.storageKey);
        }

        return result;
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
                setSelectedCharacterChatStorageKey('');
                return;
            }

            const chats = await fetchCharacterChats(snapshot.characterKey, snapshot.currentChatId, snapshot.currentChatStorageKey);

            if (requestId !== refreshRequestRef.current) {
                return;
            }

            const storageKeysByFilename = getCharacterPagesBucket(snapshot.characterKey)[CHARACTER_PAGES_STORAGE_KEYS_KEY];
            const nextChats = chats.map((chat) => ({
                ...chat,
                storageKey: getCachedChatStorageKey(snapshot.characterKey, chat.id)
                    || storageKeysByFilename[chat.id]
                    || getSafeCurrentChatStorageKey(
                        snapshot.characterKey,
                        chat.id,
                        snapshot.currentChatId,
                        snapshot.currentChatStorageKey,
                        snapshot.currentChatMainChat,
                    ),
            }));

            setCharacterChats(nextChats);

            if (getSafeCurrentChatStorageKey(
                snapshot.characterKey,
                snapshot.currentChatId,
                snapshot.currentChatId,
                snapshot.currentChatStorageKey,
                snapshot.currentChatMainChat,
            )) {
                setCachedChatStorageKey(snapshot.characterKey, snapshot.currentChatId, snapshot.currentChatStorageKey);
            }

            const shouldKeepSelectedChat = preserveSelectedChat && previousContextInfo.characterKey === snapshot.characterKey;
            const preferredChatId = shouldKeepSelectedChat ? selectedCharacterChatIdRef.current : snapshot.currentChatId;
            const nextSelectedChatId = nextChats.some((chat) => chat.id === preferredChatId)
                ? preferredChatId
                : nextChats[0]?.id ?? '';
            const nextSelectedChatStorageKey = nextChats.find((chat) => chat.id === nextSelectedChatId)?.storageKey
                ?? getSafeCurrentChatStorageKey(
                    snapshot.characterKey,
                    nextSelectedChatId,
                    snapshot.currentChatId,
                    snapshot.currentChatStorageKey,
                    snapshot.currentChatMainChat,
                );

            setSelectedCharacterChatId(nextSelectedChatId);
            setSelectedCharacterChatStorageKey(nextSelectedChatStorageKey);
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
        const activeChatMetadata = selectedCharacterChatId === contextInfo.currentChatId ? SillyTavern.getContext().chatMetadata : null;

        if (
            notesMode !== NOTES_MODE.CHARACTER
            || characterNotesScope !== CHARACTER_NOTES_SCOPE.CHAT
            || !contextInfo.characterKey
            || !selectedCharacterChatId
        ) {
            setSelectedCharacterChatStorageKey('');
            return undefined;
        }

        const knownStorageKey = getCachedChatStorageKey(contextInfo.characterKey, selectedCharacterChatId)
            || getPersistedChatStorageKey(contextInfo.characterKey, selectedCharacterChatId)
            || characterChats.find((chat) => chat.id === selectedCharacterChatId)?.storageKey
            || getSafeCurrentChatStorageKey(
                contextInfo.characterKey,
                selectedCharacterChatId,
                contextInfo.currentChatId,
                contextInfo.currentChatStorageKey,
                contextInfo.currentChatMainChat,
            );

        setSelectedCharacterChatStorageKey(knownStorageKey);

        async function resolveStorageKey() {
            const { storageKey, sourceKey } = await resolveCharacterChatStorageKey(contextInfo.characterKey, selectedCharacterChatId, {
                currentChatId: contextInfo.currentChatId,
                currentChatMetadata: activeChatMetadata,
                activeChatIds: characterChats.map((chat) => chat.id),
            });

            if (cancelled) {
                return;
            }

            if (storageKey) {
                StateManager.migrateCharacterChatPages(contextInfo.characterKey, selectedCharacterChatId, storageKey, sourceKey);
            }

            setSelectedCharacterChatStorageKey(storageKey);
        }

        void resolveStorageKey();

        return () => {
            cancelled = true;
        };
    }, [
        notesMode,
        characterNotesScope,
        contextInfo.characterKey,
        contextInfo.currentChatId,
        contextInfo.currentChatStorageKey,
        selectedCharacterChatId,
        characterChats,
    ]);

    useEffect(() => {
        const nextPages = getPagesForScope(
            notesMode,
            characterNotesScope,
            {
                ...contextInfo,
                selectedChatStorageKey: selectedCharacterChatStorageKey,
            },
            selectedCharacterChatId,
        );

        setPages(nextPages);
        setSelectedIndex((index) => clampSelectedIndex(index, nextPages.length));
    }, [notesMode, characterNotesScope, contextInfo.characterKey, selectedCharacterChatId, selectedCharacterChatStorageKey]);

    function persistPages(nextPages) {
        if (notesMode === NOTES_MODE.CHARACTER) {
            StateManager.setCharacterPages(
                contextInfo.characterKey,
                characterNotesScope,
                selectedCharacterChatId,
                selectedCharacterChatStorageKey,
                nextPages,
            );
            return;
        }

        StateManager.setGlobalPages(nextPages);
    }

    function switchToScope(nextNotesMode, nextCharacterNotesScope = characterNotesScope, nextSelectedCharacterChatId = selectedCharacterChatId) {
        const nextSelectedCharacterChatStorageKey = getCachedChatStorageKey(contextInfo.characterKey, nextSelectedCharacterChatId)
            || getPersistedChatStorageKey(contextInfo.characterKey, nextSelectedCharacterChatId)
            || characterChats.find((chat) => chat.id === nextSelectedCharacterChatId)?.storageKey
            || getSafeCurrentChatStorageKey(
                contextInfo.characterKey,
                nextSelectedCharacterChatId,
                contextInfo.currentChatId,
                contextInfo.currentChatStorageKey,
                contextInfo.currentChatMainChat,
            );
        const nextPages = getPagesForScope(
            nextNotesMode,
            nextCharacterNotesScope,
            {
                ...contextInfo,
                selectedChatStorageKey: nextSelectedCharacterChatStorageKey,
            },
            nextSelectedCharacterChatId,
        );

        setNotesMode(nextNotesMode);
        setCharacterNotesScope(nextCharacterNotesScope);
        setSelectedCharacterChatId(nextSelectedCharacterChatId);
        setSelectedCharacterChatStorageKey(nextSelectedCharacterChatStorageKey);
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
        selectedCharacterChatStorageKey || selectedCharacterChatId,
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
