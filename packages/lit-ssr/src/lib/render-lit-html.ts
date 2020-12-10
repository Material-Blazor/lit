/// <reference lib="dom" />

/**
 * @license
 * Copyright (c) 2019 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

// Type-only imports
import {TemplateResult, NodePart} from 'lit-html';

import {
  nothing,
  noChange,
  NODE_PART,
  EVENT_PART,
  PROPERTY_PART,
  BOOLEAN_ATTRIBUTE_PART,
  AttributePart,
  PropertyPart,
  BooleanAttributePart,
  EventPart,
} from 'lit-html';

import {_$private} from 'lit-html/private-ssr-support.js';

const {
  getTemplateHtml,
  marker,
  markerMatch,
  boundAttributeSuffix,
  patchDirectiveResolve,
  getAtributePartCommittedValue,
  resolveDirective,
} = _$private;

import {digestForTemplateResult} from 'lit-html/hydrate.js';

import {ElementRenderer} from './element-renderer.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const escapeHtml = require('escape-html') as typeof import('escape-html');

// types only
import {DefaultTreeDocumentFragment} from 'parse5';

import {
  traverse,
  parseFragment,
  isCommentNode,
  isElement,
} from './util/parse5-utils.js';

import {isRenderLightDirective} from 'lit-html/directives/render-light.js';
import {LitElement} from 'lit-element';
import {LitElementRenderer} from './lit-element-renderer.js';
import {reflectedAttributeName} from './reflected-attributes.js';
import {Directive} from 'lit-html/directive';

declare module 'parse5' {
  interface DefaultTreeElement {
    isDefinedCustomElement?: boolean;
  }
}

patchDirectiveResolve(
  Directive.prototype,
  function (this: Directive, values: unknown[]) {
    const {_part, _attributeIndex} = this;
    return resolveDirective(
      _part,
      this.render(...values),
      this,
      _attributeIndex
    );
  }
);

const templateCache = new Map<TemplateStringsArray, Array<Op>>();
/**

 * Operation to output static text
 */
type TextOp = {
  type: 'text';
  value: string;
};

/**
 * Operation to output dynamic text from the associated template result value
 */
type NodePartOp = {
  type: 'node-part';
  index: number;
  useCustomElementInstance?: boolean;
};

/**
 * Operation to output an attribute with bindings. Includes all bindings for an
 * attribute, like an attribute template part or AttributeComitter.
 */
type AttributePartOp = {
  type: 'attribute-part';
  index: number;
  name: string;
  ctor: typeof AttributePart;
  strings: Array<string>;
  tagName: string;
  useCustomElementInstance?: boolean;
};

/**
 * Operator to create a custom element instance.
 */
type CustomElementOpenOp = {
  type: 'custom-element-open';
  tagName: string;
  ctor: {new (): HTMLElement};
  staticAttributes: Map<string, string>;
};

/**
 * Operation to render a custom element's attributes. This is separate from
 * `custom-element-open` because attribute/property parts go in between and need
 * to run and be set on the instance before we render the element's final
 * attributes.
 */
type CustomElementAttributesOp = {
  type: 'custom-element-attributes';
};

/**
 * Operation to render a custom element's children, usually its shadow root.
 */
type CustomElementShadowOp = {
  type: 'custom-element-shadow';
};

/**
 * Operation to close a custom element so that its no longer available for
 * bindings.
 */
type CustomElementClosedOp = {
  type: 'custom-element-close';
};

type Op =
  | TextOp
  | NodePartOp
  | AttributePartOp
  | CustomElementOpenOp
  | CustomElementAttributesOp
  | CustomElementShadowOp
  | CustomElementClosedOp;

/**
 * For a given TemplateResult, generates and/or returns a cached list of opcodes
 * for the associated Template.  Opcodes are designed to allow emitting
 * contiguous static text from the template as much as possible, with specific
 * non-`text` opcodes interleaved to perform dynamic work, such as emitting
 * values for NodeParts or AttributeParts, and handling custom elements.
 *
 * For the following example template, an opcode list may look like this:
 *
 * ```js
 * html`<div><span>Hello</span><span class=${'bold'}>${template()}</span></div>`
 * ```
 *
 * - `text`
 *   - Emit run of static text: `<div><span>Hello</span><span`
 * - `attribute-part`
 *   - Emit an AttributePart's value, e.g. ` class="bold"`
 * - `text`
 *   - Emit run of static text: `>`
 * - `node-part`
 *   - Emit the NodePart's value, in this case a TemplateResult, thus we recurse
 *     into that template's opcodes
 * - `text`
 *   - Emit run of static text: `/span></div>`
 *
 * When a custom-element is encountered, the flow looks like this:
 *
 * ```js
 * html`<x-foo staticAttr dynamicAttr=${value}><div>child</div>...</x-foo>`
 * ```
 *
 * - `text`
 *   - Emit open tag `<x-foo`
 * - `custom-element-open`
 *   - Create the CE `instance`+`renderer` and put on
 *     `customElementInstanceStack`
 *   - Call `renderer.setAttribute()` for any `staticAttributes` (e.g.
 *     'staticAttr`)
 * - `attribute-part`(s)
 *   - Call `renderer.setAttribute()` or `renderer.setProperty()` for
 *     `AttributePart`/`PropertyPart`s (e.g. for `dynamicAttr`)
 * - `custom-element-attributes`
 *   - Call `renderer.connectedCallback()`
 *   - Emit `renderer.renderAttributes()`
 * - `text`
 *   - Emit end of of open tag `>`
 *   - Emit `<!--lit-bindings n-->` marker if there were attribute parts
 * - `custom-element-shadow`
 *   - Emit `renderer.renderShadow()` (emits `<template shadowroot>` +
 *     recurses to emit `render()`)
 * - `text`
 *   - Emit run of static text within tag: `<div>child</div>...`
 * - ...(recurse to render more parts/children)...
 * - `custom-element-close`
 *   - Pop the CE `instance`+`renderer` off the `customElementInstanceStack`
 */
const getTemplateOpcodes = (result: TemplateResult) => {
  const template = templateCache.get(result.strings);
  if (template !== undefined) {
    return template;
  }
  const [html, attrNames] = getTemplateHtml(result.strings, result._$litType$);

  /**
   * The html string is parsed into a parse5 AST with source code information
   * on; this lets us skip over certain ast nodes by string character position
   * while walking the AST.
   */
  const ast = parseFragment(html, {
    sourceCodeLocationInfo: true,
  }) as DefaultTreeDocumentFragment;

  const ops: Array<Op> = [];

  /* The last offset of html written to the stream */
  let lastOffset: number | undefined = 0;

  /* Current attribute part index, for indexing attrNames */
  let attrIndex = 0;

  /**
   * Sets `lastOffset` to `offset`, skipping a range of characters. This is
   * useful for skipping and re-writing lit-html marker nodes, bound attribute
   * suffix, etc.
   */
  const skipTo = (offset: number) => {
    if (lastOffset === undefined) {
      throw new Error('lastOffset is undefined');
    }
    if (offset < lastOffset) {
      throw new Error(`offset must be greater than lastOffset.
        offset: ${offset}
        lastOffset: ${lastOffset}
      `);
    }
    lastOffset = offset;
  };

  /**
   * Records the given string to the output, either by appending to the current
   * opcode (if already `text`) or by creating a new `text` opcode (if the
   * previous opocde was not `text)
   */
  const flush = (value: string) => {
    const op = getLast(ops);
    if (op !== undefined && op.type === 'text') {
      op.value += value;
    } else {
      ops.push({
        type: 'text',
        value,
      });
    }
  };

  /**
   * Creates or appends to a text opcode with a substring of the html from the
   * `lastOffset` flushed to `offset`.
   */
  const flushTo = (offset?: number) => {
    if (lastOffset === undefined) {
      throw new Error('lastOffset is undefined');
    }
    const previousLastOffset = lastOffset;
    lastOffset = offset;
    const value = html.substring(previousLastOffset, offset);
    flush(value);
  };

  // Depth-first node index. Initialized to -1 (corresponding to the fragment
  // root node at the top of the ast) so that the first child node is
  // index 0, to match client-side lit-html.
  let nodeIndex = -1;

  traverse(ast, {
    pre(node, parent) {
      if (isCommentNode(node)) {
        if (node.data === markerMatch) {
          flushTo(node.sourceCodeLocation!.startOffset);
          skipTo(node.sourceCodeLocation!.endOffset);
          ops.push({
            type: 'node-part',
            index: nodeIndex,
            useCustomElementInstance:
              parent && isElement(parent) && parent.isDefinedCustomElement,
          });
        }
      } else if (isElement(node)) {
        // Whether to flush the start tag. This is necessary if we're changing
        // any of the attributes in the tag, so it's true for custom-elements
        // which might reflect their own state, or any element with a binding.
        let writeTag = false;
        let boundAttrsCount = 0;

        const tagName = node.tagName;
        let ctor;

        if (tagName.indexOf('-') !== -1) {
          // Looking up the constructor here means that custom elements must be
          // registered before rendering the first template that contains them.
          ctor = customElements.get(tagName);
          if (ctor !== undefined) {
            // Write the start tag
            writeTag = true;
            // Mark that this is a custom element
            node.isDefinedCustomElement = true;
            ops.push({
              type: 'custom-element-open',
              tagName,
              ctor,
              staticAttributes: new Map(
                node.attrs
                  .filter((attr) => !attr.name.endsWith(boundAttributeSuffix))
                  .map((attr) => [attr.name, attr.value])
              ),
            });
          }
        }
        if (node.attrs.length > 0) {
          for (const attr of node.attrs) {
            if (attr.name.endsWith(boundAttributeSuffix)) {
              writeTag = true;
              boundAttrsCount += 1;
              // Note that although we emit a lit-bindings comment marker for any
              // nodes with bindings, we don't account for it in the nodeIndex because
              // that will not be injected into the client template
              const strings = attr.value.split(marker);
              // We store the case-sensitive name from `attrNames` (generated
              // while parsing the template strings); note that this assumes
              // parse5 attribute ordering matches string ordering
              const [, prefix, caseSensitiveName] = /([.?@])?(.*)/.exec(
                attrNames[attrIndex++]
              )!;
              const attrSourceLocation = node.sourceCodeLocation!.attrs[
                attr.name
              ];
              const attrNameStartOffset = attrSourceLocation.startOffset;
              const attrEndOffset = attrSourceLocation.endOffset;
              flushTo(attrNameStartOffset);
              ops.push({
                type: 'attribute-part',
                index: nodeIndex,
                name: caseSensitiveName,
                ctor:
                  prefix === '.'
                    ? PropertyPart
                    : prefix === '?'
                    ? BooleanAttributePart
                    : prefix === '@'
                    ? EventPart
                    : AttributePart,
                strings,
                tagName,
                useCustomElementInstance: ctor !== undefined,
              });
              skipTo(attrEndOffset);
            } else if (node.isDefinedCustomElement) {
              // For custom elements, all static attributes are stored along
              // with the `custom-element-open` opcode so that we can set them
              // into the custom element instance, and then serialize them back
              // out along with any manually-reflected attributes. As such, we
              // skip over static attribute text here.
              const attrSourceLocation = node.sourceCodeLocation!.attrs[
                attr.name
              ];
              flushTo(attrSourceLocation.startOffset);
              skipTo(attrSourceLocation.endOffset);
            }
          }
        }

        if (writeTag) {
          if (node.isDefinedCustomElement) {
            flushTo(node.sourceCodeLocation!.startTag.endOffset - 1);
            ops.push({
              type: 'custom-element-attributes',
            });
            flush('>');
            skipTo(node.sourceCodeLocation!.startTag.endOffset);
          } else {
            flushTo(node.sourceCodeLocation!.startTag.endOffset);
          }
        }

        if (boundAttrsCount > 0) {
          flush(`<!--lit-bindings ${nodeIndex}-->`);
        }

        if (ctor !== undefined) {
          ops.push({
            type: 'custom-element-shadow',
          });
        }
      }
      nodeIndex++;
    },
    post(node) {
      if (isElement(node) && node.isDefinedCustomElement) {
        ops.push({
          type: 'custom-element-close',
        });
      }
    },
  });
  // Flush remaining static text in the template (e.g. closing tags)
  flushTo();
  templateCache.set(result.strings, ops);
  return ops;
};

export type RenderInfo = {
  customElementInstanceStack: Array<ElementRenderer | undefined>;
};

declare global {
  interface Array<T> {
    flat(depth: number): Array<T>;
  }
}

export function* render(value: unknown): IterableIterator<string> {
  yield* renderValue(value, {customElementInstanceStack: []});
}

export function* renderValue(
  value: unknown,
  renderInfo: RenderInfo
): IterableIterator<string> {
  if (isRenderLightDirective(value)) {
    // If a value was produced with renderLight(), we want to call and render
    // the renderLight() method.
    const instance = getLast(renderInfo.customElementInstanceStack);
    if (instance !== undefined) {
      yield* instance.renderLight(renderInfo);
    }
    value = null;
  } else {
    value = resolveDirective({type: NODE_PART} as NodePart, value);
  }
  if (value != null && (value as TemplateResult)._$litType$ !== undefined) {
    yield `<!--lit-part ${digestForTemplateResult(value as TemplateResult)}-->`;
    yield* renderTemplateResult(value as TemplateResult, renderInfo);
  } else {
    yield `<!--lit-part-->`;
    if (
      value === undefined ||
      value === null ||
      value === nothing ||
      value === noChange
    ) {
      // yield nothing
    } else if (Array.isArray(value)) {
      for (const item of value) {
        yield* renderValue(item, renderInfo);
      }
    } else {
      yield escapeHtml(String(value));
    }
  }
  yield `<!--/lit-part-->`;
}

export function* renderTemplateResult(
  result: TemplateResult,
  renderInfo: RenderInfo
): IterableIterator<string> {
  // In order to render a TemplateResult we have to handle and stream out
  // different parts of the result separately:
  //   - Literal sections of the template
  //   - Defined custom element within the literal sections
  //   - Values in the result
  //
  // This means we can't just iterate through the template literals and values,
  // we must parse and traverse the template's HTML. But we don't want to pay
  // the cost of serializing the HTML node-by-node when we already have the
  // template in string form. So we parse with location info turned on and use
  // that to index into the HTML string generated by TemplateResult.getHTML().
  // During the tree walk we will handle expression marker nodes and custom
  // elements. For each we will record the offset of the node, and output the
  // previous span of HTML.

  const ops = getTemplateOpcodes(result);

  /* The next value in result.values to render */
  let partIndex = 0;

  for (const op of ops) {
    switch (op.type) {
      case 'text':
        yield op.value;
        break;
      case 'node-part': {
        const value = result.values[partIndex++];
        yield* renderValue(value, renderInfo);
        break;
      }
      case 'attribute-part': {
        const statics = op.strings;
        const part = new op.ctor(
          // Passing null for the element is fine since the directive only gets
          // PartInfo without the node available in the constructor
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (null as any) as HTMLElement,
          op.name,
          statics,
          undefined,
          {}
        );
        const value =
          part.strings === undefined ? result.values[partIndex] : result.values;
        let committedValue: unknown = noChange;
        // Values for EventParts are never emitted
        if (!(part.type === EVENT_PART)) {
          committedValue = getAtributePartCommittedValue(
            part,
            value,
            partIndex
          );
        }
        // We don't emit anything on the server when value is `noChange` or
        // `nothing`
        if (committedValue !== noChange) {
          const instance = op.useCustomElementInstance
            ? getLast(renderInfo.customElementInstanceStack)
            : undefined;
          if (part.type === PROPERTY_PART) {
            yield* renderPropertyPart(instance, op, committedValue);
          } else if (part.type === BOOLEAN_ATTRIBUTE_PART) {
            // Boolean attribute binding
            yield* renderBooleanAttributePart(instance, op, committedValue);
          } else {
            yield* renderAttributePart(instance, op, committedValue);
          }
        }
        partIndex += statics.length - 1;
        break;
      }
      case 'custom-element-open': {
        const ctor = op.ctor;
        // Instantiate the element and its renderer
        let instance = undefined;
        try {
          const element = new ctor();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (element as any).tagName = op.tagName;
          // TODO: Move renderer instantiation into a plugin system
          if (element instanceof LitElement) {
            instance = new LitElementRenderer(element);
          } else {
            console.error(`No renderer for custom element: ${op.tagName}`);
          }
        } catch (e) {
          console.error('Exception in custom element constructor', e);
        }
        // Set static attributes to the element renderer
        if (instance !== undefined) {
          for (const [name, value] of op.staticAttributes) {
            instance?.setAttribute(name, value);
          }
        }
        renderInfo.customElementInstanceStack.push(instance);
        break;
      }
      case 'custom-element-attributes': {
        const instance = getLast(renderInfo.customElementInstanceStack);
        if (instance !== undefined) {
          // Perform any connect-time work via the renderer (e.g. reflecting any
          // properties to attributes, for example)
          if (instance.connectedCallback) {
            instance.connectedCallback();
          }
          // Render out any attributes on the instance (both static and those
          // that may have been dynamically set by the renderer)
          yield* instance.renderAttributes();
        }
        break;
      }
      case 'custom-element-shadow': {
        const instance = getLast(renderInfo.customElementInstanceStack);
        if (instance !== undefined && instance.renderShadow !== undefined) {
          yield '<template shadowroot="open">';
          yield* instance.renderShadow();
          yield '</template>';
        }
        break;
      }
      case 'custom-element-close':
        renderInfo.customElementInstanceStack.pop();
        break;
      default:
        throw new Error('internal error');
    }
  }

  if (partIndex !== result.values.length) {
    throw new Error(
      `unexpected final partIndex: ${partIndex} !== ${result.values.length}`
    );
  }
}

function* renderPropertyPart(
  instance: ElementRenderer | undefined,
  op: AttributePartOp,
  value: unknown
) {
  value = value === nothing ? undefined : value;
  // Property should be reflected to attribute
  const reflectedName = reflectedAttributeName(op.tagName, op.name);
  if (instance !== undefined) {
    instance.setProperty(op.name, value);
  }
  if (reflectedName !== undefined) {
    yield `${reflectedName}="${escapeHtml(String(value))}"`;
  }
}

function* renderBooleanAttributePart(
  instance: ElementRenderer | undefined,
  op: AttributePartOp,
  value: unknown
) {
  if (value && value !== nothing) {
    if (instance !== undefined) {
      instance.setAttribute(op.name, '');
    } else {
      yield op.name;
    }
  }
}

function* renderAttributePart(
  instance: ElementRenderer | undefined,
  op: AttributePartOp,
  value: unknown
) {
  if (value !== nothing) {
    if (instance !== undefined) {
      instance.setAttribute(op.name, value as string);
    } else {
      yield `${op.name}="${escapeHtml(String(value ?? ''))}"`;
    }
  }
}

const getLast = <T>(a: Array<T>) => a[a.length - 1];