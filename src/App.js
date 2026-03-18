/* global SillyTavern */
/* global jQuery */
import { useState, useEffect } from 'react';
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

const dragElement = await importFromUrl('/scripts/RossAscends-mods.js', 'dragElement', () => { });
const NOTEBOOK_PLUS_PAGES_PATH = 'extensionSettings.notebookPlus.pages';
const LEGACY_NOTEBOOK_PAGES_PATH = 'extensionSettings.notebook.pages';

/**
 * Persistent state manager for Notebook-Plus.
 */
class StateManager {
    /**
     * Get the list of pages in Notebook-Plus from extension settings.
     * @returns {Page[]} List of pages
     */
    static getPages() {
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
     * Set the list of pages in Notebook-Plus to extension settings.
     * @param {Page[]} pages List of pages to set
     */
    static setPages(pages) {
        const context = SillyTavern.getContext();
        _.set(context, NOTEBOOK_PLUS_PAGES_PATH, pages);
        context.saveSettingsDebounced();
    }
}

function App({ onCloseClicked }) {
    const [pages, setPages] = useState(StateManager.getPages());
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
        dragElement(jQuery(document.getElementById('notebookPlusPanel')));
    }, []);

    function handleChange(index, page) {
        const newPages = [...pages];

        if (!page) {
            newPages.splice(index, 1);
            if (selectedIndex >= newPages.length) {
                setSelectedIndex(newPages.length - 1);
            }
        } else {
            newPages[index] = page;
        }

        setPages(newPages);
        StateManager.setPages(newPages);
    }

    function addPage() {
        const newPage = { title: 'Untitled', content: '' };
        const newPages = [...pages, newPage];
        setPages(newPages);
        StateManager.setPages(newPages);
    }

    function sliceTitle(title) {
        return title && title.length > 10 ? `${title.slice(0, 10)}...` : title;
    }

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
                <Tabs selectedIndex={selectedIndex} onSelect={(index) => setSelectedIndex(index)}>
                    <TabList>
                        {pages.map((page, index) => (
                            <Tab key={index}>{sliceTitle(page.title) || '[No name]'}</Tab>
                        ))}
                        <Tab onClick={() => addPage()} title="Add a note">
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
                            <h3>Click the + button to add a note.</h3>
                        </div>
                    )}
                </Tabs>
            </div>
        </>
    );
}

export default App;
