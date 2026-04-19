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
const NOTEBOOK_PLUS_CHARACTER_SETTINGS_PATH = ['extensionSettings', 'notebookPlus', 'characterSettings'];
const CHARACTER_PAGES_GENERAL_KEY = '__generalPages';
const CHARACTER_PAGES_CHATS_KEY = '__chatPages';
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
    ? StateManager.getCharacterPages(contextInfo.characterKey, characterNotesScope, resolveStorageChatId(contextInfo.characterKey, selectedCharacterChatId))
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
    };
}

async function fetchCharacterChats(characterKey, currentChatId) {
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
        const rawChats = Object.values(chatMap)
            .map((chat) => {
                const fileId = chat?.file_name?.replace(/\.jsonl$/, '');

                if (!fileId) {
                    return null;
                }

                const meta = chat?.chat_metadata ?? {};
                const integrity = typeof meta.integrity === 'string' && meta.integrity.length > 0 ? meta.integrity : null;
                const chatIdHash = meta.chat_id_hash !== undefined && meta.chat_id_hash !== null ? String(meta.chat_id_hash) : null;
                const stableKey = integrity || chatIdHash || fileId;

                return {
                    id: fileId,
                    title: fileId,
                    stableKey,
                    meta,
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
        // build per-character mapping fileId -> stableKey and perform migration
        const mapping = rawChats.reduce((acc, c) => {
            acc[c.id] = c.stableKey;
            return acc;
        }, {});

        FILE_TO_META_MAP[characterKey] = mapping;

        // migrate existing stored pages from fileId keys to stable keys (non-destructive copy)
        try {
            StateManager.migrateChatKeys(characterKey, mapping);

            // If user enabled branch inheritance, copy parent pages into branch pages when empty
            const inheritSetting = StateManager.getCharacterSetting(characterKey)?.inheritBranches;
            if (inheritSetting) {
                StateManager.copyParentPagesToBranchesIfEmpty(characterKey, rawChats, mapping);
            }
        } catch (err) {
            // non-fatal
            console.warn('Notebook-Plus migration/branch-copy failed for', characterKey, err);
        }

        return rawChats;
    } catch (error) {
        console.error('Failed to load character chats for Notebook-Plus', error);
        return [];
    }
}

// Module-level per-character mapping from fileId -> stable metadata key
const FILE_TO_META_MAP = {};

function resolveStorageChatId(characterKey, fileId) {
    if (!characterKey || !fileId) {
        return fileId || '';
    }

    const map = FILE_TO_META_MAP[characterKey] || {};
    return map[fileId] || fileId;
}

function normalizeCharacterPagesBucket(bucket) {
    if (!_.isPlainObject(bucket)) {
        return {
            [CHARACTER_PAGES_GENERAL_KEY]: [],
            [CHARACTER_PAGES_CHATS_KEY]: {},
        };
    }

    if (Array.isArray(bucket[CHARACTER_PAGES_GENERAL_KEY]) || _.isPlainObject(bucket[CHARACTER_PAGES_CHATS_KEY])) {
        const chatPages = _.isPlainObject(bucket[CHARACTER_PAGES_CHATS_KEY])
            ? Object.entries(bucket[CHARACTER_PAGES_CHATS_KEY]).reduce((pagesByChat, [chatId, pages]) => {
                if (Array.isArray(pages)) {
                    pagesByChat[chatId] = pages;
                }

                return pagesByChat;
            }, {})
            : {};

        return {
            [CHARACTER_PAGES_GENERAL_KEY]: Array.isArray(bucket[CHARACTER_PAGES_GENERAL_KEY]) ? bucket[CHARACTER_PAGES_GENERAL_KEY] : [],
            [CHARACTER_PAGES_CHATS_KEY]: chatPages,
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
    static getCharacterPages(characterKey, characterNotesScope, chatId = '') {
        if (!characterKey) {
            return [];
        }

        const context = SillyTavern.getContext();
        const bucket = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey]));

        if (characterNotesScope === CHARACTER_NOTES_SCOPE.CARD) {
            return bucket[CHARACTER_PAGES_GENERAL_KEY];
        }

        // Primary: try requested chatId (may be stable metadata key)
        if (Array.isArray(bucket[CHARACTER_PAGES_CHATS_KEY][chatId])) {
            return bucket[CHARACTER_PAGES_CHATS_KEY][chatId];
        }

        // Fallback: if we have a mapping for this character, try to locate a legacy fileId that maps to this stable key
        const map = FILE_TO_META_MAP[characterKey] || {};
        const legacyFileId = Object.keys(map).find((fileId) => map[fileId] === chatId);

        if (legacyFileId && Array.isArray(bucket[CHARACTER_PAGES_CHATS_KEY][legacyFileId])) {
            return bucket[CHARACTER_PAGES_CHATS_KEY][legacyFileId];
        }

        // Final fallback: return empty
        return [];
    }

    /**
     * Set the list of character pages in Notebook-Plus to extension settings.
     * @param {string} characterKey Character avatar key
     * @param {CharacterNotesScope} characterNotesScope Character note scope
     * @param {string} chatId Chat file name without extension
     * @param {Page[]} pages List of pages to set
     */
    static setCharacterPages(characterKey, characterNotesScope, chatId, pages) {
        if (!characterKey) {
            return;
        }

        const context = SillyTavern.getContext();
        const bucket = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey]));

        if (characterNotesScope === CHARACTER_NOTES_SCOPE.CARD) {
            bucket[CHARACTER_PAGES_GENERAL_KEY] = pages;
        } else if (chatId) {
            bucket[CHARACTER_PAGES_CHATS_KEY][chatId] = pages;
        } else {
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

        if (previousPages[CHARACTER_PAGES_GENERAL_KEY].length === 0 && Object.keys(previousPages[CHARACTER_PAGES_CHATS_KEY]).length === 0) {
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
        };

        _.set(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, newCharacterKey], mergedPages);
        _.unset(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, oldCharacterKey]);
        context.saveSettingsDebounced();
    }

    /**
     * Migrate stored per-character chat pages from fileId keys to stable metadata keys.
     * @param {string} characterKey Character avatar key
     * @param {{[fileId:string]:string}} mapping Map of fileId -> stableKey
     */
    static migrateChatKeys(characterKey, mapping) {
        if (!characterKey || !mapping || Object.keys(mapping).length === 0) {
            return;
        }

        const context = SillyTavern.getContext();
        const bucket = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey]));
        const chatPages = bucket[CHARACTER_PAGES_CHATS_KEY] || {};

        let mutated = false;

        Object.entries(mapping).forEach(([fileId, stableKey]) => {
            if (!fileId || !stableKey || fileId === stableKey) {
                return;
            }

            // Non-destructive copy: if pages are stored under the legacy filename key and there
            // is not already content under the stable key, copy them there but keep the legacy key.
            if (Array.isArray(chatPages[fileId]) && !Array.isArray(chatPages[stableKey])) {
                chatPages[stableKey] = chatPages[fileId];
                mutated = true;
            }
        });

        if (mutated) {
            _.set(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey], bucket);
            context.saveSettingsDebounced();
        }
    }

    /**
     * Copy pages from a source storage key to destination storage key if destination is empty.
     * Non-destructive.
     * @param {string} characterKey
     * @param {string} fromStorageKey
     * @param {string} toStorageKey
     */
    static copyPagesFromToIfEmpty(characterKey, fromStorageKey, toStorageKey) {
        if (!characterKey || !fromStorageKey || !toStorageKey || fromStorageKey === toStorageKey) {
            return;
        }

        const context = SillyTavern.getContext();
        const bucket = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey]));
        const chatPages = bucket[CHARACTER_PAGES_CHATS_KEY] || {};

        const destHas = Array.isArray(chatPages[toStorageKey]) && chatPages[toStorageKey].length > 0;
        const srcHas = Array.isArray(chatPages[fromStorageKey]) && chatPages[fromStorageKey].length > 0;

        if (!destHas && srcHas) {
            chatPages[toStorageKey] = _.cloneDeep(chatPages[fromStorageKey]);
            _.set(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey], bucket);
            context.saveSettingsDebounced();
        }
    }

    /**
     * Get character-specific settings for Notebook-Plus.
     * @param {string} characterKey
     * @returns {{inheritBranches?:boolean}} settings
     */
    static getCharacterSetting(characterKey) {
        if (!characterKey) {
            return {};
        }

        const context = SillyTavern.getContext();
        const settings = _.get(context, [...NOTEBOOK_PLUS_CHARACTER_SETTINGS_PATH, characterKey]);
        return _.isPlainObject(settings) ? settings : {};
    }

    /**
     * Set character-specific settings for Notebook-Plus.
     * @param {string} characterKey
     * @param {{inheritBranches?:boolean}} settings
     */
    static setCharacterSetting(characterKey, settings) {
        if (!characterKey) {
            return;
        }

        const context = SillyTavern.getContext();
        _.set(context, [...NOTEBOOK_PLUS_CHARACTER_SETTINGS_PATH, characterKey], settings);
        context.saveSettingsDebounced();
    }

    /**
     * Copy parent (main_chat) pages into branch pages if branch page list is empty.
     * Non-destructive: only copies when destination has no pages.
     * @param {string} characterKey
     * @param {Array} rawChats Array of chat objects with {id, stableKey, meta}
     * @param {{[fileId:string]:string}} mapping
     */
    static copyParentPagesToBranchesIfEmpty(characterKey, rawChats, mapping) {
        if (!characterKey || !Array.isArray(rawChats) || rawChats.length === 0) {
            return;
        }

        const context = SillyTavern.getContext();
        const bucket = normalizeCharacterPagesBucket(_.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey]));
        const chatPages = bucket[CHARACTER_PAGES_CHATS_KEY] || {};
        let mutated = false;

        // Build reverse map stableKey -> fileId for lookups
        const reverseMap = Object.entries(mapping).reduce((acc, [fileId, stableKey]) => {
            acc[stableKey] = fileId;
            return acc;
        }, {});

        function normalizeKey(s) {
            return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().toLowerCase() : s;
        }

        rawChats.forEach((chat) => {
            const mainChatVal = chat?.meta?.main_chat;
            if (!mainChatVal) {
                return;
            }

            const normalizedMain = normalizeKey(mainChatVal);

            // try to find parent by multiple strategies
            let parent = rawChats.find((c) => c.id === mainChatVal || c.title === mainChatVal || c.stableKey === mainChatVal);
            if (!parent) {
                parent = rawChats.find((c) => normalizeKey(c.id) === normalizedMain || normalizeKey(c.title) === normalizedMain || String(c.stableKey) === normalizedMain);
            }

            // if still not found, try reverseMap (mainChatVal could be a stableKey)
            let parentFileId = parent?.id || null;
            if (!parentFileId && reverseMap[mainChatVal]) {
                parentFileId = reverseMap[mainChatVal];
            }

            // Also check if mainChatVal directly matches a mapping key
            if (!parentFileId && mapping[mainChatVal]) {
                parentFileId = mainChatVal;
            }

            const childStable = chat.stableKey;

            // candidate parent keys to look up in stored pages
            const candidateParentKeys = [];
            if (parentFileId) {
                const parentStable = mapping[parentFileId] || null;
                if (parentStable) candidateParentKeys.push(parentStable);
                candidateParentKeys.push(parentFileId);
            }

            // also include mainChatVal and any reverseMap matches
            if (mainChatVal) candidateParentKeys.push(mainChatVal);
            if (reverseMap[mainChatVal]) candidateParentKeys.push(reverseMap[mainChatVal]);

            // make unique
            const uniqCandidates = Array.from(new Set(candidateParentKeys.filter(Boolean)));

            const destHas = Array.isArray(chatPages[childStable]) && chatPages[childStable].length > 0;
            if (!destHas) {
                let parentPages = null;
                for (const key of uniqCandidates) {
                    if (Array.isArray(chatPages[key]) && chatPages[key].length > 0) {
                        parentPages = chatPages[key];
                        break;
                    }
                }

                if (Array.isArray(parentPages) && parentPages.length > 0) {
                    chatPages[childStable] = _.cloneDeep(parentPages);
                    mutated = true;
                }
            }
        });

        if (mutated) {
            _.set(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey], bucket);
            context.saveSettingsDebounced();
        }
    }
}

function App({ onCloseClicked }) {
    const [pages, setPages] = useState(StateManager.getGlobalPages());
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [notesMode, setNotesMode] = useState(NOTES_MODE.GLOBAL);
    const [characterNotesScope, setCharacterNotesScope] = useState(CHARACTER_NOTES_SCOPE.CHAT);
    const [contextInfo, setContextInfo] = useState(() => getNotebookContextSnapshot());
    const [characterChats, setCharacterChats] = useState([]);
    const [inheritBranches, setInheritBranches] = useState(false);
    const [selectedCharacterChatId, setSelectedCharacterChatId] = useState(() => getNotebookContextSnapshot().currentChatId);
    const refreshRequestRef = useRef(0);
    const contextInfoRef = useRef(contextInfo);
    const selectedCharacterChatIdRef = useRef(selectedCharacterChatId);

    useEffect(() => {
        contextInfoRef.current = contextInfo;
    }, [contextInfo]);

    useEffect(() => {
        // update inheritBranches when character key changes
        const key = contextInfo.characterKey;
        if (!key) {
            setInheritBranches(false);
            return;
        }

        const setting = StateManager.getCharacterSetting(key);
        setInheritBranches(Boolean(setting?.inheritBranches));
    }, [contextInfo.characterKey]);

    useEffect(() => {
        selectedCharacterChatIdRef.current = selectedCharacterChatId;
    }, [selectedCharacterChatId]);

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
                return;
            }

            const chats = await fetchCharacterChats(snapshot.characterKey, snapshot.currentChatId);

            if (requestId !== refreshRequestRef.current) {
                return;
            }

            setCharacterChats(chats);

            // ensure current inheritBranches state reflects saved setting (in case it changed externally)
            const setting = StateManager.getCharacterSetting(snapshot.characterKey);
            setInheritBranches(Boolean(setting?.inheritBranches));

            const shouldKeepSelectedChat = preserveSelectedChat && previousContextInfo.characterKey === snapshot.characterKey;
            const preferredChatId = shouldKeepSelectedChat ? selectedCharacterChatIdRef.current : snapshot.currentChatId;
            const nextSelectedChatId = chats.some((chat) => chat.id === preferredChatId)
                ? preferredChatId
                : chats[0]?.id ?? '';

            // If branch inheritance is enabled, and the next selected chat is a branch whose
            // `main_chat` points to the previous chat, copy parent pages to the branch if empty.
            try {
                const inheritSetting = StateManager.getCharacterSetting(snapshot.characterKey)?.inheritBranches;
                if (inheritSetting && previousContextInfo.characterKey === snapshot.characterKey) {
                    const prevChatId = previousContextInfo.currentChatId;
                    const mapping = FILE_TO_META_MAP[snapshot.characterKey] || {};
                    const nextChatObj = chats.find((c) => c.id === nextSelectedChatId);

                    if (prevChatId && nextChatObj && nextChatObj.meta && nextChatObj.meta.main_chat) {
                        const mainVal = nextChatObj.meta.main_chat;
                        const prevStable = mapping[prevChatId] || prevChatId;

                        const normalize = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().toLowerCase() : '');
                        const matchesPrev = (mainVal === prevChatId)
                            || (mainVal === prevStable)
                            || (mapping[mainVal] === prevChatId)
                            || (mapping[mainVal] === prevStable)
                            || (normalize(mainVal) === normalize(prevChatId))
                            || (normalize(mainVal) === normalize(prevStable));

                        if (matchesPrev) {
                            const srcKey = prevStable;
                            const dstKey = mapping[nextSelectedChatId] || nextSelectedChatId;
                            StateManager.copyPagesFromToIfEmpty(snapshot.characterKey, srcKey, dstKey);
                        }
                    }
                }
            } catch (err) {
                console.warn('Branch inheritance check failed', err);
            }

            setSelectedCharacterChatId(nextSelectedChatId);
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
        const nextPages = getPagesForScope(notesMode, characterNotesScope, contextInfo, selectedCharacterChatId);

        setPages(nextPages);
        setSelectedIndex((index) => clampSelectedIndex(index, nextPages.length));
    }, [notesMode, characterNotesScope, contextInfo.characterKey, selectedCharacterChatId]);

    function persistPages(nextPages) {
        if (notesMode === NOTES_MODE.CHARACTER) {
            const storageChatId = resolveStorageChatId(contextInfo.characterKey, selectedCharacterChatId);
            StateManager.setCharacterPages(contextInfo.characterKey, characterNotesScope, storageChatId, nextPages);

            // For compatibility with older versions, also write to the legacy filename key if different.
            if (selectedCharacterChatId && storageChatId !== selectedCharacterChatId) {
                StateManager.setCharacterPages(contextInfo.characterKey, characterNotesScope, selectedCharacterChatId, nextPages);
            }
            return;
        }

        StateManager.setGlobalPages(nextPages);
    }

    function switchToScope(nextNotesMode, nextCharacterNotesScope = characterNotesScope, nextSelectedCharacterChatId = selectedCharacterChatId) {
        const nextPages = getPagesForScope(nextNotesMode, nextCharacterNotesScope, contextInfo, nextSelectedCharacterChatId);

        setNotesMode(nextNotesMode);
        setCharacterNotesScope(nextCharacterNotesScope);
        setSelectedCharacterChatId(nextSelectedCharacterChatId);
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
    const activeScopeKey = getActiveScopeKey(notesMode, characterNotesScope, contextInfo, selectedCharacterChatId);
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
                        <label style={{ marginLeft: '8px', display: 'inline-flex', alignItems: 'center' }}>
                            <input
                                type="checkbox"
                                checked={inheritBranches}
                                onChange={(e) => {
                                    const next = Boolean(e.target.checked);
                                    setInheritBranches(next);
                                    StateManager.setCharacterSetting(contextInfo.characterKey, { inheritBranches: next });

                                    if (next && contextInfo.characterKey) {
                                        // run copy-once for branches now
                                        try {
                                            StateManager.copyParentPagesToBranchesIfEmpty(contextInfo.characterKey, characterChats, FILE_TO_META_MAP[contextInfo.characterKey] || {});
                                        } catch (err) {
                                            console.warn('Branch inherit copy failed', err);
                                        }
                                    }
                                }}
                            />
                            <span style={{ marginLeft: '6px' }}>Branches inherit this chatfile notes</span>
                        </label>
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
