import NameManager from "../NameManager";
import {ContextualKeyword, Token} from "../parser/tokenizer";
import {TokenType as tt} from "../parser/tokenizer/types";
import TokenProcessor from "../TokenProcessor";
import RootTransformer from "../transformers/RootTransformer";

export interface ClassHeaderInfo {
  isExpression: boolean;
  className: string | null;
  hasSuperclass: boolean;
}

export interface TokenRange {
  start: number;
  end: number;
}

export interface FieldInfo extends TokenRange {
  equalsIndex: number;
  initializerName: string;
}

/**
 * Information about a class returned to inform the implementation of class fields and constructor
 * initializers.
 */
export interface ClassInfo {
  headerInfo: ClassHeaderInfo;
  // Array of non-semicolon-delimited code strings to go in the constructor, after super if
  // necessary.
  initializerStatements: Array<string>;
  // Array of static initializer statements, with the class name omitted. For example, if we need to
  // run `C.x = 3;`, an element of this array will be `.x = 3`.
  staticInitializerSuffixes: Array<string>;
  // Token index after which we should insert initializer statements (either the start of the
  // constructor, or after the super call), or null if there was no constructor.
  constructorInsertPos: number | null;
  fields: Array<FieldInfo>;
  rangesToRemove: Array<TokenRange>;
}

/**
 * Get information about the class fields for this class, given a token processor pointing to the
 * open-brace at the start of the class.
 */
export default function getClassInfo(
  rootTransformer: RootTransformer,
  tokens: TokenProcessor,
  nameManager: NameManager,
): ClassInfo {
  const snapshot = tokens.snapshot();

  const headerInfo = processClassHeader(tokens);

  let constructorInitializers: Array<string> = [];
  const classInitializers: Array<string> = [];
  const staticInitializerSuffixes: Array<string> = [];
  let constructorInsertPos = null;
  const fields: Array<FieldInfo> = [];
  const rangesToRemove: Array<TokenRange> = [];

  const classContextId = tokens.currentToken().contextId;
  if (classContextId == null) {
    throw new Error("Expected non-null class context ID on class open-brace.");
  }

  tokens.nextToken();
  while (!tokens.matchesContextIdAndLabel(tt.braceR, classContextId)) {
    if (tokens.matchesContextual(ContextualKeyword._constructor)) {
      ({constructorInitializers, constructorInsertPos} = processConstructor(tokens));
    } else if (tokens.matches1(tt.semi)) {
      rangesToRemove.push({start: tokens.currentIndex(), end: tokens.currentIndex() + 1});
      tokens.nextToken();
    } else if (tokens.currentToken().isType) {
      tokens.nextToken();
    } else {
      // Either a method or a field. Skip to the identifier part.
      const statementStartIndex = tokens.currentIndex();
      let isStatic = false;
      while (isAccessModifier(tokens.currentToken())) {
        if (tokens.matches1(tt._static)) {
          isStatic = true;
        }
        tokens.nextToken();
      }
      if (tokens.matchesContextual(ContextualKeyword._constructor)) {
        ({constructorInitializers, constructorInsertPos} = processConstructor(tokens));
        continue;
      }
      const nameStartIndex = tokens.currentIndex();
      skipFieldName(tokens);
      if (tokens.matches1(tt.lessThan) || tokens.matches1(tt.parenL)) {
        // This is a method, so just skip to the next method/field. To do that, we seek forward to
        // the next start of a class name (either an open bracket or an identifier, or the closing
        // curly brace), then seek backward to include any access modifiers.
        while (tokens.currentToken().contextId !== classContextId) {
          tokens.nextToken();
        }
        while (isAccessModifier(tokens.tokenAtRelativeIndex(-1))) {
          tokens.previousToken();
        }
        continue;
      }
      // There might be a type annotation that we need to skip.
      while (tokens.currentToken().isType) {
        tokens.nextToken();
      }
      if (tokens.matches1(tt.eq)) {
        const equalsIndex = tokens.currentIndex();
        // This is an initializer, so we need to wrap in an initializer method.
        const valueEnd = tokens.currentToken().rhsEndIndex;
        if (valueEnd == null) {
          throw new Error("Expected rhsEndIndex on class field assignment.");
        }
        tokens.nextToken();
        while (tokens.currentIndex() < valueEnd) {
          rootTransformer.processToken();
        }
        let initializerName;
        if (isStatic) {
          initializerName = nameManager.claimSymbol("__initStatic");
          staticInitializerSuffixes.push(`[${initializerName}]()`);
        } else {
          initializerName = nameManager.claimSymbol("__init");
          classInitializers.push(`this[${initializerName}]()`);
        }
        // Fields start at the name, so `static x = 1;` has a field range of `x = 1;`.
        fields.push({
          initializerName,
          equalsIndex,
          start: nameStartIndex,
          end: tokens.currentIndex(),
        });
      } else {
        // This is just a declaration, so doesn't need to produce any code in the output.
        rangesToRemove.push({start: statementStartIndex, end: tokens.currentIndex()});
      }
    }
  }

  tokens.restoreToSnapshot(snapshot);
  return {
    headerInfo,
    initializerStatements: [...constructorInitializers, ...classInitializers],
    staticInitializerSuffixes,
    constructorInsertPos,
    fields,
    rangesToRemove,
  };
}

function processClassHeader(tokens: TokenProcessor): ClassHeaderInfo {
  const classToken = tokens.currentToken();
  const contextId = classToken.contextId;
  if (contextId == null) {
    throw new Error("Expected context ID on class token.");
  }
  const isExpression = classToken.isExpression;
  if (isExpression == null) {
    throw new Error("Expected isExpression on class token.");
  }
  let className = null;
  let hasSuperclass = false;
  tokens.nextToken();
  if (tokens.matches1(tt.name)) {
    className = tokens.identifierName();
  }
  while (!tokens.matchesContextIdAndLabel(tt.braceL, contextId)) {
    if (tokens.matches1(tt._extends)) {
      hasSuperclass = true;
    }
    tokens.nextToken();
  }
  return {isExpression, className, hasSuperclass};
}

/**
 * Extract useful information out of a constructor, starting at the "constructor" name.
 */
function processConstructor(
  tokens: TokenProcessor,
): {constructorInitializers: Array<string>; constructorInsertPos: number} {
  const constructorInitializers = [];

  tokens.nextToken();
  const constructorContextId = tokens.currentToken().contextId;
  if (constructorContextId == null) {
    throw new Error("Expected context ID on open-paren starting constructor params.");
  }
  tokens.nextToken();
  // Advance through parameters looking for access modifiers.
  while (!tokens.matchesContextIdAndLabel(tt.parenR, constructorContextId)) {
    if (isAccessModifier(tokens.currentToken())) {
      tokens.nextToken();
      while (isAccessModifier(tokens.currentToken())) {
        tokens.nextToken();
      }
      const token = tokens.currentToken();
      if (token.type !== tt.name) {
        throw new Error("Expected identifier after access modifiers in constructor arg.");
      }
      const name = tokens.identifierNameForToken(token);
      constructorInitializers.push(`this.${name} = ${name}`);
    }
    tokens.nextToken();
  }
  // )
  tokens.nextToken();
  let constructorInsertPos = tokens.currentIndex();

  // Advance through body looking for a super call.
  while (!tokens.matchesContextIdAndLabel(tt.braceR, constructorContextId)) {
    if (tokens.matches1(tt._super)) {
      tokens.nextToken();
      const superCallContextId = tokens.currentToken().contextId;
      if (superCallContextId == null) {
        throw new Error("Expected a context ID on the super call");
      }
      while (!tokens.matchesContextIdAndLabel(tt.parenR, superCallContextId)) {
        tokens.nextToken();
      }
      constructorInsertPos = tokens.currentIndex();
    }
    tokens.nextToken();
  }
  // }
  tokens.nextToken();

  return {constructorInitializers, constructorInsertPos};
}

/**
 * Determine if this is any token that can go before the name in a method/field.
 */
function isAccessModifier(token: Token): boolean {
  return [
    tt._async,
    tt._get,
    tt._set,
    tt.plus,
    tt.minus,
    tt._readonly,
    tt._static,
    tt._public,
    tt._private,
    tt._protected,
    tt._abstract,
  ].includes(token.type);
}

/**
 * The next token or set of tokens is either an identifier or an expression in square brackets, for
 * a method or field name.
 */
function skipFieldName(tokens: TokenProcessor): void {
  if (tokens.matches1(tt.bracketL)) {
    const startToken = tokens.currentToken();
    const classContextId = startToken.contextId;
    if (classContextId == null) {
      throw new Error("Expected class context ID on computed name open bracket.");
    }
    while (!tokens.matchesContextIdAndLabel(tt.bracketR, classContextId)) {
      tokens.nextToken();
    }
    tokens.nextToken();
  } else {
    tokens.nextToken();
  }
}
