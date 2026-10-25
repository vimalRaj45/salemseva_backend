/**
 * ============================================================================
 * SHAZU ONE: DOM MUTATION SHIELD UNIT TEST
 * Verifies that the monkey-patch on Node.prototype.removeChild and insertBefore
 * prevents crashes when external translators (Google Translate) alter the DOM.
 * ============================================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Simulated DOM Environment for Node.js
class MockNode {
  constructor(nodeName) {
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
  }

  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    if (child.parentNode !== this) {
      throw new Error("NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.");
    }
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
    }
    child.parentNode = null;
    return child;
  }

  insertBefore(newNode, referenceNode) {
    if (referenceNode && referenceNode.parentNode !== this) {
      throw new Error("NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.");
    }
    const idx = this.childNodes.indexOf(referenceNode);
    if (idx !== -1) {
      this.childNodes.splice(idx, 0, newNode);
    } else {
      this.childNodes.push(newNode);
    }
    newNode.parentNode = this;
    return newNode;
  }
}

// Applying our DOM Armor
function applyDomShield(NodeClass) {
  const originalRemoveChild = NodeClass.prototype.removeChild;
  NodeClass.prototype.removeChild = function (child) {
    if (child && child.parentNode !== this) {
      if (child.parentNode) {
        return child.parentNode.removeChild(child);
      }
      return child;
    }
    return originalRemoveChild.apply(this, arguments);
  };

  const originalInsertBefore = NodeClass.prototype.insertBefore;
  NodeClass.prototype.insertBefore = function (newNode, referenceNode) {
    if (referenceNode && referenceNode.parentNode !== this) {
      return this.appendChild(newNode);
    }
    return originalInsertBefore.apply(this, arguments);
  };
}

describe('Unit Test: Google Translate DOM Mutation Armor', () => {
  it('unshielded removeChild should throw NotFoundError when node is wrapped in foreign tag', () => {
    const parent = new MockNode('DIV');
    const child = new MockNode('SPAN');
    parent.appendChild(child);

    // Google translate wraps child inside <FONT>
    const fontWrapper = new MockNode('FONT');
    parent.removeChild(child); // unmounts temporarily to wrap
    fontWrapper.appendChild(child);
    parent.appendChild(fontWrapper);

    // child.parentNode is now fontWrapper, NOT parent!
    assert.equal(child.parentNode, fontWrapper);

    // React tries to remove child from parent directly
    assert.throws(
      () => parent.removeChild(child),
      /The node to be removed is not a child of this node/
    );
  });

  it('shielded removeChild safely unlinks altered child without throwing NotFoundError', () => {
    // Apply armor to MockNode
    applyDomShield(MockNode);

    const parent = new MockNode('DIV');
    const child = new MockNode('SPAN');
    parent.appendChild(child);

    // External translator alters hierarchy
    const fontWrapper = new MockNode('FONT');
    const idx = parent.childNodes.indexOf(child);
    parent.childNodes.splice(idx, 1);
    fontWrapper.appendChild(child);
    parent.appendChild(fontWrapper);

    assert.equal(child.parentNode, fontWrapper);

    // React tries to remove child from parent
    // With shield, this should NOT throw!
    assert.doesNotThrow(() => {
      parent.removeChild(child);
    });

    // child should be safely removed from fontWrapper
    assert.equal(child.parentNode, null);
  });

  it('shielded insertBefore appends node when referenceNode parent was altered', () => {
    const parent = new MockNode('DIV');
    const refNode = new MockNode('P');
    const newNode = new MockNode('H1');

    // refNode belongs to a different parent
    const foreignParent = new MockNode('SECTION');
    foreignParent.appendChild(refNode);

    // With shield, insertBefore falls back to appendChild safely
    assert.doesNotThrow(() => {
      parent.insertBefore(newNode, refNode);
    });

    assert.equal(newNode.parentNode, parent);
    assert.ok(parent.childNodes.includes(newNode));
  });
});
