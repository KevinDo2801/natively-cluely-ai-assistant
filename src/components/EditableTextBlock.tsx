import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';

interface EditableTextBlockProps {
    initialValue: string;
    onSave: (value: string) => void;
    tagName?: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div';
    className?: string;
    placeholder?: string;
    multiline?: boolean;
    onEnter?: () => void;
    autoFocus?: boolean;
}

/**
 * EditableTextBlock — a contentEditable span/heading/etc. with debounced save.
 *
 * Why this is implemented the way it is (caret stability):
 *
 * The text lives inside a native `contentEditable`. The browser owns the live DOM
 * text while the user types. If React *also* owns that text (e.g. by rendering
 * `{initialValue}` or `{localValue}` as a JSX child), then any re-render of this
 * component — including the one caused by our own debounced `onSave` flowing back
 * through `initialValue` from the parent — makes React reconcile the text node.
 * Because React tracks its *previous rendered* value rather than the live, already
 * browser-edited text, that reconciliation rewrites the text node inside the open
 * contentEditable and the caret snaps to 0 or the end ("nhảy lung tung").
 *
 * The fix: never render the editable text through a React child node. Keep the
 * element's text as `null` children and write text into the DOM imperatively via
 * `innerText`, only when the element is NOT being edited. While editing, React never
 * touches the live text, so the browser caret is left completely alone.
 *
 * A happy side effect of leaving children as `null` is that Tailwind's `empty:`
 * (`&:empty`) placeholder still works: the element is `:empty` whenever we haven't
 * imperatively inserted a text node (i.e. whenever the value is empty).
 */
const EditableTextBlock: React.FC<EditableTextBlockProps> = ({
    initialValue,
    onSave,
    tagName = 'div',
    className = '',
    placeholder = 'Type here...',
    multiline = true,
    onEnter,
    autoFocus = false
}) => {
    const [isEditing, setIsEditing] = useState(autoFocus); // Start editing if autoFocus is true
    const contentRef = useRef<HTMLElement>(null);

    // localValue is the logical current text. While editing it mirrors the live DOM
    // (updated on every input) but it is only ever written to the DOM when NOT editing.
    const [localValue, setLocalValue] = useState(initialValue);

    const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastEnterTime = useRef<number>(0);

    const handleSave = useCallback((newValue: string) => {
        const trimmed = newValue.trim();
        // Only save if changed
        if (trimmed !== initialValue) {
            onSave(trimmed);
        }
    }, [initialValue, onSave]);

    // Imperatively keep the DOM text in sync with localValue, only while NOT editing.
    // During editing the browser owns the text and we deliberately do nothing, so
    // React never rewrites live content and never moves the caret.
    useLayoutEffect(() => {
        if (isEditing) return;
        const el = contentRef.current;
        if (!el) return;
        if (el.innerText !== localValue) {
            el.innerText = localValue;
        }
    }, [localValue, isEditing]);

    // When NOT editing, keep localValue in sync with an externally changed initialValue
    // (e.g. remote rename). The DOM write happens through the effect above.
    useEffect(() => {
        if (!isEditing) {
            setLocalValue(initialValue);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialValue]);

    const handleChange = useCallback(() => {
        if (!contentRef.current) return;
        const newValue = contentRef.current.innerText;
        // Mirror the live DOM so revert/save know the current text, but never write it
        // back (we are editing).
        setLocalValue(newValue);

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }
        saveTimeoutRef.current = setTimeout(() => {
            handleSave(newValue);
        }, 600); // 600ms debounce
    }, [handleSave]);

    const handleBlur = useCallback(() => {
        setIsEditing(false);
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }
        if (contentRef.current) {
            handleSave(contentRef.current.innerText);
        }
    }, [handleSave]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            // Revert both the DOM and the logical value to the committed initialValue.
            setIsEditing(false);
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
            if (contentRef.current) {
                contentRef.current.innerText = initialValue;
            }
            setLocalValue(initialValue);
        } else if (e.key === 'Enter') {
            if (!multiline) {
                e.preventDefault();
                contentRef.current?.blur();
            } else if (onEnter) {
                // Double-Enter detection (500ms threshold)
                const now = Date.now();
                if (now - lastEnterTime.current < 500) {
                    // Double-Enter detected!
                    e.preventDefault();
                    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
                    if (contentRef.current) handleSave(contentRef.current.innerText);
                    onEnter();
                    lastEnterTime.current = 0; // Reset
                } else {
                    // First Enter: Allow default (newline) + track time
                    lastEnterTime.current = now;
                }
            }
        }
    };

    const handleClick = () => {
        setIsEditing(true);
    };

    // Focus management when editing begins.
    useEffect(() => {
        if (isEditing && contentRef.current) {
            contentRef.current.focus();
        }
    }, [isEditing]);

    const Tag = tagName as any;

    return (
        <Tag
            ref={contentRef}
            contentEditable={isEditing}
            suppressContentEditableWarning={true}
            onClick={handleClick}
            onBlur={handleBlur}
            onInput={handleChange}
            onKeyDown={handleKeyDown}
            className={`
                outline-none min-w-[10px] cursor-text transition-colors duration-200
                bg-transparent
                ${!localValue && placeholder ? 'empty:before:content-[attr(data-placeholder)] empty:before:text-white/20' : ''}
                ${className}
            `}
            data-placeholder={placeholder}
            spellCheck={false} // Clean look
        >
            {/* Deliberately no React child here — see the component doc comment above.
                Display text is seeded imperatively by the layout effect. Keep this
                element `:empty` so the placeholder utility matches for blank values. */}
            {null}
        </Tag>
    );
};

export default EditableTextBlock;
