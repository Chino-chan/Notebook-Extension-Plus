/* eslint-disable no-restricted-globals */
import React from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';

const Quill = ReactQuill.Quill;
const SizeStyle = Quill.import('attributors/style/size');
const FONT_SIZE_OPTIONS = ['11px', '12px', '14px', '16px', '18px', '20px', '24px', '32px'];
const PERSISTED_INLINE_FORMATS = ['color', 'size'];
const HEADER_SIZE_DEFAULTS = Object.freeze({
    normal: '14px',
    1: '32px',
    2: '24px',
    3: '20px',
});

SizeStyle.whitelist = FONT_SIZE_OPTIONS;
Quill.register(SizeStyle, true);

function normalizeHeaderValue(value) {
    if (value === false || value == null || value === '' || value === 'false') {
        return false;
    }

    const numericValue = Number(value);
    return Number.isNaN(numericValue) ? value : numericValue;
}

function getHeaderSizeKey(headerValue) {
    return normalizeHeaderValue(headerValue) === false ? 'normal' : String(normalizeHeaderValue(headerValue));
}

function getHeaderSizeMap(quill) {
    if (!quill.__notebookPlusHeaderSizeMap) {
        quill.__notebookPlusHeaderSizeMap = { ...HEADER_SIZE_DEFAULTS };
    }

    return quill.__notebookPlusHeaderSizeMap;
}

function getMappedHeaderSize(quill, headerValue) {
    const headerKey = getHeaderSizeKey(headerValue);
    const sizeMap = getHeaderSizeMap(quill);
    return sizeMap[headerKey] ?? HEADER_SIZE_DEFAULTS[headerKey] ?? HEADER_SIZE_DEFAULTS.normal;
}

function rememberHeaderSize(quill, headerValue, sizeValue) {
    if (!FONT_SIZE_OPTIONS.includes(sizeValue)) {
        return;
    }

    getHeaderSizeMap(quill)[getHeaderSizeKey(headerValue)] = sizeValue;
}

const quillModules = {
    toolbar: {
        container: [
            [{ size: [false, ...FONT_SIZE_OPTIONS] }, { header: ['1', '2', '3', false] }],
            ['bold', 'italic', 'underline', 'link'],
            [{ list: 'ordered' }, { list: 'bullet' }, { color: [] }, 'copy'],
            ['clean'],
        ],
        handlers: {
            header(value) {
                this.quill.focus();
                const headerValue = normalizeHeaderValue(value);
                const mappedSize = getMappedHeaderSize(this.quill, headerValue);

                this.quill.format('header', headerValue, Quill.sources.USER);
                this.quill.format('size', mappedSize, Quill.sources.USER);
            },
            size(value) {
                this.quill.focus();

                const selection = this.quill.getSelection(true) ?? {
                    index: Math.max(this.quill.getLength() - 1, 0),
                    length: 0,
                };
                const currentFormats = this.quill.getFormat(selection);
                const currentHeader = normalizeHeaderValue(currentFormats.header);
                const sizeValue = FONT_SIZE_OPTIONS.includes(value)
                    ? value
                    : getMappedHeaderSize(this.quill, currentHeader);

                rememberHeaderSize(this.quill, currentHeader, sizeValue);
                this.quill.format('size', sizeValue, Quill.sources.USER);
            },
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
