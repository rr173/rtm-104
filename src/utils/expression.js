class Tokenizer {
  constructor(input) {
    this.input = input;
    this.pos = 0;
    this.tokens = [];
    this.tokenize();
  }

  tokenize() {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];

      if (/\s/.test(ch)) {
        this.pos++;
        continue;
      }

      if (/\d/.test(ch)) {
        if (this.looksLikeIdentifier()) {
          this.readIdentifier();
        } else {
          this.readNumber();
        }
        continue;
      }

      if (ch === '.' && /\d/.test(this.input[this.pos + 1])) {
        this.readNumber();
        continue;
      }

      if (/[a-zA-Z_]/.test(ch)) {
        this.readIdentifier();
        continue;
      }

      if ('+-*/(),'.includes(ch)) {
        this.tokens.push({ type: ch, value: ch });
        this.pos++;
        continue;
      }

      throw new Error(`Unexpected character: ${ch} at position ${this.pos}`);
    }
    this.tokens.push({ type: 'EOF', value: null });
  }

  looksLikeIdentifier() {
    let p = this.pos;
    while (p < this.input.length && /\d/.test(this.input[p])) p++;
    if (p < this.input.length && /[a-zA-Z_]/.test(this.input[p])) return true;
    if (p < this.input.length && this.input[p] === '-' && p + 1 < this.input.length && /[a-zA-Z0-9]/.test(this.input[p + 1])) return true;
    return false;
  }

  readNumber() {
    let start = this.pos;
    while (this.pos < this.input.length && /\d/.test(this.input[this.pos])) {
      this.pos++;
    }
    if (this.input[this.pos] === '.' && /\d/.test(this.input[this.pos + 1])) {
      this.pos++;
      while (this.pos < this.input.length && /\d/.test(this.input[this.pos])) {
        this.pos++;
      }
    }
    this.tokens.push({
      type: 'NUMBER',
      value: parseFloat(this.input.slice(start, this.pos))
    });
  }

  readIdentifier() {
    let start = this.pos;
    this.readIdentPart();
    while (
      this.pos < this.input.length &&
      this.input[this.pos] === '-' &&
      this.pos + 1 < this.input.length &&
      /[a-zA-Z0-9]/.test(this.input[this.pos + 1])
    ) {
      this.pos++;
      this.readIdentPart();
    }
    if (this.pos < this.input.length && this.input[this.pos] === '.') {
      this.pos++;
      this.readIdentPart();
    }
    const id = this.input.slice(start, this.pos);
    if (id.includes('.')) {
      this.tokens.push({ type: 'REFERENCE', value: id });
    } else {
      this.tokens.push({ type: 'IDENT', value: id });
    }
  }

  readIdentPart() {
    while (this.pos < this.input.length && /[a-zA-Z0-9_]/.test(this.input[this.pos])) {
      this.pos++;
    }
  }
}

const FUNCS = {
  max: (args) => Math.max(...args),
  min: (args) => Math.min(...args),
  avg: (args) => args.reduce((a, b) => a + b, 0) / args.length,
  abs: (args) => Math.abs(args[0]),
  sqrt: (args) => Math.sqrt(args[0])
};

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  consume() {
    return this.tokens[this.pos++];
  }

  expect(type) {
    const tok = this.consume();
    if (tok.type !== type) {
      throw new Error(`Expected ${type}, got ${tok.type}`);
    }
    return tok;
  }

  parse() {
    const result = this.parseExpr();
    if (this.peek().type !== 'EOF') {
      throw new Error('Unexpected token after expression');
    }
    return result;
  }

  parseExpr() {
    let left = this.parseTerm();
    while (this.peek().type === '+' || this.peek().type === '-') {
      const op = this.consume();
      const right = this.parseTerm();
      left = { type: 'Binary', op: op.value, left, right };
    }
    return left;
  }

  parseTerm() {
    let left = this.parseFactor();
    while (this.peek().type === '*' || this.peek().type === '/') {
      const op = this.consume();
      const right = this.parseFactor();
      left = { type: 'Binary', op: op.value, left, right };
    }
    return left;
  }

  parseFactor() {
    const tok = this.peek();

    if (tok.type === '+' || tok.type === '-') {
      this.consume();
      const operand = this.parseFactor();
      return { type: 'Unary', op: tok.value, operand };
    }

    if (tok.type === 'NUMBER') {
      this.consume();
      return { type: 'Number', value: tok.value };
    }

    if (tok.type === 'REFERENCE') {
      this.consume();
      return { type: 'Reference', name: tok.value };
    }

    if (tok.type === 'IDENT') {
      this.consume();
      this.expect('(');
      const args = [];
      if (this.peek().type !== ')') {
        args.push(this.parseExpr());
        while (this.peek().type === ',') {
          this.consume();
          args.push(this.parseExpr());
        }
      }
      this.expect(')');
      if (!FUNCS[tok.value]) {
        throw new Error(`Unknown function: ${tok.value}`);
      }
      return { type: 'FuncCall', name: tok.value, args };
    }

    if (tok.type === '(') {
      this.consume();
      const expr = this.parseExpr();
      this.expect(')');
      return expr;
    }

    throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
  }
}

class Evaluator {
  constructor(resolver) {
    this.resolver = resolver;
  }

  eval(ast) {
    switch (ast.type) {
      case 'Number':
        return ast.value;
      case 'Reference':
        return this.resolver(ast.name);
      case 'Unary': {
        const v = this.eval(ast.operand);
        return ast.op === '-' ? -v : v;
      }
      case 'Binary': {
        const l = this.eval(ast.left);
        const r = this.eval(ast.right);
        switch (ast.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return l / r;
          default: throw new Error(`Unknown operator: ${ast.op}`);
        }
      }
      case 'FuncCall': {
        const args = ast.args.map(a => this.eval(a));
        return FUNCS[ast.name](args);
      }
      default:
        throw new Error(`Unknown AST node: ${ast.type}`);
    }
  }
}

function parseExpression(input) {
  const tokenizer = new Tokenizer(input);
  const parser = new Parser(tokenizer.tokens);
  return parser.parse();
}

function evaluateExpression(input, resolver) {
  const ast = parseExpression(input);
  const evaluator = new Evaluator(resolver);
  return evaluator.eval(ast);
}

function getReferences(ast) {
  const refs = new Set();

  function walk(node) {
    if (!node) return;
    if (node.type === 'Reference') {
      refs.add(node.name);
    } else if (node.type === 'Binary') {
      walk(node.left);
      walk(node.right);
    } else if (node.type === 'Unary') {
      walk(node.operand);
    } else if (node.type === 'FuncCall') {
      node.args.forEach(walk);
    }
  }

  walk(ast);
  return [...refs];
}

module.exports = {
  parseExpression,
  evaluateExpression,
  getReferences,
  FUNCS
};
