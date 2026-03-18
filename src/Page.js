/* eslint-disable no-restricted-globals */
import React from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';

const Quill = ReactQuill.Quill;
const Delta = Quill.import('delta');
const PERSISTED_INLINE_FORMATS = ['color', 'background'];

async function readClipboardContents() {
    if (navigator.clipboard?.read) {
        try {
            const clipboardItems = await navigator.clipboard.read();

            for (const item of clipboardItems) {
                const html = item.types.includes('text/html')
                    ? await (await item.getType('text/html')).text()
                    : '';
                const text = item.types.includes('text/plain')
                    ? await (await item.getType('text/plain')).text()
                    : '';

                if (html || text) {
                    return { html, text };
                }
            }
        } catch (error) {
            console.warn('Rich clipboard access failed in Notebook-Plus, falling back to plain text paste.', error);
        }
    }

    if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        return { html: '', text };
    }

    return { html: '', text: '' };
}

const quillModules = {
    toolbar: {
        container: [
            [{ header: ['1', '2', '3', false] }],
            ['bold', 'italic', 'underline', 'link'],
            [{ list: 'ordered' }, { list: 'bullet' }, { color: [] }, { background: [] }, 'copy', 'paste'],
            ['clean'],
        ],
        handlers: {
            copy() {
                const selection = this.quill.getSelection(true);

                if (selection == null) {
                    return;
                }

                const contentLength = Math.max(this.quill.getLength() - 1, 0);
                const shouldCopyWholeEditor = selection.length === 0;

                if (shouldCopyWholeEditor) {
                    if (contentLength === 0) {
                        return;
                    }

                    this.quill.setSelection(0, contentLength, Quill.sources.SILENT);
                }

                this.quill.focus();
                document.execCommand('copy');

                if (shouldCopyWholeEditor) {
                    this.quill.setSelection(selection.index, selection.length, Quill.sources.SILENT);
                }
            },
            async paste() {
                const range = this.quill.getSelection(true);

                if (range == null) {
                    return;
                }

                try {
                    const { html, text } = await readClipboardContents();

                    if (!html && !text) {
                        return;
                    }

                    const pastedDelta = html
                        ? this.quill.clipboard.convert({ html, text })
                        : new Delta().insert(text);
                    const delta = new Delta()
                        .retain(range.index)
                        .delete(range.length)
                        .concat(pastedDelta);

                    this.quill.updateContents(delta, Quill.sources.USER);
                    this.quill.setSelection(range.index + pastedDelta.length(), Quill.sources.SILENT);
                    this.quill.scrollSelectionIntoView();
                } catch (error) {
                    console.error('Failed to paste from the clipboard in Notebook-Plus', error);
                }
            },
        },
    },
    keyboard: {
        bindings: {
            persistInlineFormatsOnEnter: {
                key: 'Enter',
                shiftKey: null,
                collapsed: true,
                handler(range, context) {
                    const inlineFormats = PERSISTED_INLINE_FORMATS.reduce((formats, format) => {
                        if (context.format[format] != null) {
                            formats[format] = context.format[format];
                        }

                        return formats;
                    }, {});

                    if (Object.keys(inlineFormats).length === 0) {
                        return true;
                    }

                    this.handleEnter(range, context);

                    Object.entries(inlineFormats).forEach(([format, value]) => {
                        this.quill.format(format, value, Quill.sources.USER);
                    });

                    return false;
                },
            },
        },
    },
};

/**
 * Component for displaying a page in the notebook.
 * @param {object} props - Component props
 * @param {import('./App').Page} props.page - The page to display
 * @param {function} props.onChange - The function to call when the page content changes
 * @returns
 */
export default function Page({ page, onChange }) {
    return (
        <div className="flex-container flexFlowColumn">
            <div className="flex-container alignItemsCenter">
                <input placeholder="Enter a title..." className="text_pole flex1" type="text" value={page.title} onChange={(event) => onChange({ ...page, title: event.target.value })} />
                <i className="right_menu_button fa-solid fa-trash" onClick={() => confirm('Are you sure?') && onChange(null)}></i>
            </div>
            <ReactQuill
                placeholder="What's on your mind?"
                theme="snow"
                modules={quillModules}
                value={page.content}
                onChange={(content) => onChange({ ...page, content })}
                scrollingContainer={document.getElementById('notebookPlusPanelHolder')}
            />
        </div>
    );
}
