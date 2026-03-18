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

const dragElement = await importFromUrl('/scripts/RossAscends-mods.js', 'dragElement', () => { });
const NOTEBOOK_PLUS_PAGES_PATH = ['extensionSettings', 'notebookPlus', 'pages'];
const NOTEBOOK_PLUS_CHARACTER_PAGES_PATH = ['extensionSettings', 'notebookPlus', 'characterPages'];
const LEGACY_NOTEBOOK_PAGES_PATH = 'extensionSettings.notebook.pages';
const NOTES_MODE = {
    CHARACTER: 'character',
    GLOBAL: 'global',
};

function clampSelectedIndex(index, pageCount) {
    return pageCount <= 0 ? 0 : Math.min(index, pageCount - 1);
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
        return Object.values(chatMap)
            .map((chat) => {
                const chatId = chat?.file_name?.replace(/\.jsonl$/, '');

                if (!chatId) {
                    return null;
                }

                return {
                    id: chatId,
                    title: chatId,
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

function getCharacterDropdownPlaceholder(notesMode, characterName) {
    if (notesMode === NOTES_MODE.GLOBAL) {
        return 'Character notes disabled in Global mode';
    }

    if (characterName) {
        return `No chats found for ${characterName}`;
    }

    return 'Open a character chat to use Character Notes';
}

function getEmptyStateMessage(notesMode, contextInfo, selectedCharacterChatId) {
    if (notesMode === NOTES_MODE.CHARACTER) {
        if (!contextInfo.characterKey) {
            return 'Open a character chat to use Character Notes.';
        }

        if (!selectedCharacterChatId) {
            return 'No chat files are available for this character card.';
        }
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
     * @param {string} chatId Chat file name without extension
     * @returns {Page[]} List of pages
     */
    static getCharacterPages(characterKey, chatId) {
        if (!characterKey || !chatId) {
            return [];
        }

        const context = SillyTavern.getContext();
        const pages = _.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey, chatId]);
        return Array.isArray(pages) ? pages : [];
    }

    /**
     * Set the list of character pages in Notebook-Plus to extension settings.
     * @param {string} characterKey Character avatar key
     * @param {string} chatId Chat file name without extension
     * @param {Page[]} pages List of pages to set
     */
    static setCharacterPages(characterKey, chatId, pages) {
        if (!characterKey || !chatId) {
            return;
        }

        const context = SillyTavern.getContext();
        _.set(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, characterKey, chatId], pages);
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
        const previousPages = _.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, oldCharacterKey]);

        if (!_.isPlainObject(previousPages)) {
            return;
        }

        const currentPages = _.get(context, [...NOTEBOOK_PLUS_CHARACTER_PAGES_PATH, newCharacterKey]);
        const mergedPages = {
            ..._.cloneDeep(previousPages),
            ...(_.isPlainObject(currentPages) ? _.cloneDeep(currentPages) : {}),
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
    const [contextInfo, setContextInfo] = useState(() => getNotebookContextSnapshot());
    const [characterChats, setCharacterChats] = useState([]);
    const [selectedCharacterChatId, setSelectedCharacterChatId] = useState(() => getNotebookContextSnapshot().currentChatId);
    const refreshRequestRef = useRef(0);
    const contextInfoRef = useRef(contextInfo);
    const selectedCharacterChatIdRef = useRef(selectedCharacterChatId);

    useEffect(() => {
        contextInfoRef.current = contextInfo;
    }, [contextInfo]);

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

            const shouldKeepSelectedChat = preserveSelectedChat && previousContextInfo.characterKey === snapshot.characterKey;
            const preferredChatId = shouldKeepSelectedChat ? selectedCharacterChatIdRef.current : snapshot.currentChatId;
            const nextSelectedChatId = chats.some((chat) => chat.id === preferredChatId)
                ? preferredChatId
                : chats[0]?.id ?? '';

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
        const nextPages = notesMode === NOTES_MODE.CHARACTER
            ? StateManager.getCharacterPages(contextInfo.characterKey, selectedCharacterChatId)
            : StateManager.getGlobalPages();

        setPages(nextPages);
        setSelectedIndex((index) => clampSelectedIndex(index, nextPages.length));
    }, [notesMode, contextInfo.characterKey, selectedCharacterChatId]);

    function persistPages(nextPages) {
        if (notesMode === NOTES_MODE.CHARACTER) {
            StateManager.setCharacterPages(contextInfo.characterKey, selectedCharacterChatId, nextPages);
            return;
        }

        StateManager.setGlobalPages(nextPages);
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

    const characterDropdownDisabled = notesMode !== NOTES_MODE.CHARACTER || characterChats.length === 0;
    const canEditCurrentScope = notesMode === NOTES_MODE.GLOBAL || Boolean(contextInfo.characterKey && selectedCharacterChatId);
    const selectedDropdownValue = notesMode === NOTES_MODE.CHARACTER && characterChats.some((chat) => chat.id === selectedCharacterChatId)
        ? selectedCharacterChatId
        : '';
    const emptyStateMessage = getEmptyStateMessage(notesMode, contextInfo, selectedCharacterChatId);
    const characterDropdownPlaceholder = getCharacterDropdownPlaceholder(notesMode, contextInfo.characterName);

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
                            className={`notebookPlusScopeButton ${notesMode === NOTES_MODE.CHARACTER ? 'is-active' : ''}`}
                            onClick={() => setNotesMode(NOTES_MODE.CHARACTER)}
                        >
                            Character Notes
                        </button>
                        <button
                            type="button"
                            className={`notebookPlusScopeButton ${notesMode === NOTES_MODE.GLOBAL ? 'is-active' : ''}`}
                            onClick={() => setNotesMode(NOTES_MODE.GLOBAL)}
                        >
                            Global
                        </button>
                    </div>
                    <select
                        className="text_pole notebookPlusChatSelect"
                        value={selectedDropdownValue}
                        onChange={(event) => setSelectedCharacterChatId(event.target.value)}
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
                <Tabs selectedIndex={selectedIndex} onSelect={handleTabSelect}>
                    <TabList>
                        {pages.map((page, index) => (
                            <Tab key={index}>{sliceTitle(page.title) || '[No name]'}</Tab>
                        ))}
                        <Tab title="Add a note" disabled={!canEditCurrentScope}>
                            <i className="fa-solid fa-plus"></i>
                        </Tab>
                    </TabList>
                    {pages.map((page, index) => (
                        <TabPanel key={index}>
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
