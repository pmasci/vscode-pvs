import org.antlr.v4.runtime.*;
import java.util.*;
import org.antlr.v4.runtime.ANTLRInputStream;
import org.antlr.v4.runtime.CommonTokenStream;
import org.antlr.v4.runtime.ParserRuleContext;
import org.antlr.v4.runtime.Token;
import org.antlr.v4.runtime.tree.*;
import org.antlr.v4.runtime.misc.Interval;

public class PvsTypechecker {
    protected static Boolean test = false;
    protected static String ifname = null;

    public static interface DiagnosticSeverity {
        int Error = 1;
        int Warning = 2;
        int Information = 3;
        int Hint = 4;
    }
    public static class ErrorListener extends BaseErrorListener {
        protected ArrayList<String> errors = new ArrayList<String>(); // array of JSON strings in the form { range: { start: { line: number, character: number }, stop: { line: number, character: number } }, message: string } 

        @Override
        public void syntaxError(Recognizer<?, ?> recognizer,
                                Object offendingSymbol,
                                int line, int col,
                                String message,
                                RecognitionException e) {
            String start = "{ \"line\": " + line +", \"character\": " + col + " }";
            Token sym = (Token) offendingSymbol;
            int len = sym.getStopIndex() - sym.getStartIndex(); //offendingSymbol.stop - offendingSymbol.start;
            String end = "{ \"line\": " + line + ", \"character\": " + (col + 1 + len) + "}";
            // String end = "{ line: " + line + ", character: " + len + "}";
            String range = "{ \"start\": " + start + ", \"end\": " + end + "}";
            String diag = "{ \"range\": " + range + ", \"message\": \"" + message + "\", \"severity\": " + DiagnosticSeverity.Error + " }";
            this.errors.add(diag);
        }

    }
    public static class ErrorHandler extends DefaultErrorStrategy {
        // @Override public void reportNoViableAlternative(Parser parser, NoViableAltException e) {
        //     parser.notifyErrorListeners(e.getOffendingToken(), "Syntax error", e);
        // }
    }
    protected static void parseCliArgs (String[] args) {
        // System.out.println(args.toString());
        for (int a = 0; a < args.length; a++) {
            if (args[a].equals("--test") || args[a].equals("-test")) {
                test = true;
            } else {
                ifname = args[a];
            }
        }
    }
    public static class DeclDescriptor {
        int line;
        int character;
        String declaration;
        String identifier;
        DeclDescriptor (String identifier, int line, int character, String declaration) {
            this.line = line;
            this.character = character;
            this.identifier = identifier;
            this.declaration = declaration;
        }
        public String toString () {
            return "{ \"line\": " + this.line
                + ", \"character\": " + this.character
                + ", \"identifier\": \"" + this.identifier + "\""
                + ", \"declaration\": \"" + this.declaration + "\""
                + " }";
        }
    }
    public static void main(String[] args) throws Exception {
        // open file
        if (args != null && args.length > 0) {
            parseCliArgs(args);
            if (test) {
                System.out.println("Parsing file " + ifname);
            }
            CharStream input = CharStreams.fromFileName(ifname);
            PvsLanguageLexer lexer = new PvsLanguageLexer(input);
            CommonTokenStream tokens = new CommonTokenStream(lexer);
            PvsLanguageParser parser = new PvsLanguageParser(tokens);
            parser.removeErrorListeners(); // remove ConsoleErrorListener
            ErrorListener el = new ErrorListener();
            parser.addErrorListener(el); // add new error listener
            ErrorHandler eh = new ErrorHandler();
            parser.setErrorHandler(eh);
            // parser.setBuildParseTree(false); // disable parse tree creation, to speed up parsing
            ParserRuleContext tree = parser.parse(); // parse as usual
            if (el.errors.size() > 0) {
                System.out.println(el.errors);
            } else {
                if (test) {
                    System.out.println(ifname + " parsed successfully!");
                }
                // walk the tree
                ParseTreeWalker walker = new ParseTreeWalker();
                PvsTypecheckerListener listener = new PvsTypecheckerListener(tokens);
                walker.walk(listener, tree);
            }
        }
    }
    public static class PvsTypecheckerListener extends PvsLanguageBaseListener {
        protected BufferedTokenStream tokens = null;
        protected TokenStreamRewriter rewriter = null;
        protected HashMap<String, DeclDescriptor> typeDeclarations = new HashMap<String, DeclDescriptor>();
        protected HashMap<String, DeclDescriptor> formulaDeclarations = new HashMap<String, DeclDescriptor>();

        PvsTypecheckerListener (BufferedTokenStream tokens) {
            super();
            this.tokens = tokens;
            rewriter = new TokenStreamRewriter(tokens);
        }

        public String getSource (ParserRuleContext ctx) {
            Token start = ctx.getStart();
            Token stop = ctx.getStop();
            CharStream cs = start.getInputStream();
            Interval interval = new Interval(start.getStartIndex(), stop.getStopIndex());
            String src = cs.getText(interval);
            return src;
        }

        @Override public void enterTypeDeclaration(PvsLanguageParser.TypeDeclarationContext ctx) {
            ListIterator<PvsLanguageParser.IdentifierContext> it = ctx.identifier().listIterator();
            while (it.hasNext()) {
                PvsLanguageParser.IdentifierContext ictx = it.next();
                Token start = ictx.getStart();
                Token stop = ictx.getStop();
                String id = ictx.getText();
                this.typeDeclarations.put(id, 
                    new DeclDescriptor(
                        id,
                        start.getLine(),
                        start.getCharPositionInLine(),
                        this.getSource(ctx)
                    )
                );
            }
        }
        @Override public void enterFormulaDeclaration(PvsLanguageParser.FormulaDeclarationContext ctx) {
            Token start = ctx.getStart();
            Token stop = ctx.getStop();
            String id = ctx.identifier().getText();
            this.formulaDeclarations.put(id, 
                new DeclDescriptor(
                    id,
                    start.getLine(), 
                    start.getCharPositionInLine(), 
                    this.getSource(ctx)
                )
            );
        }
        @Override public void exitTheory(PvsLanguageParser.TheoryContext ctx) {
            if (test) {
                if (this.typeDeclarations != null) {
                    int n = this.typeDeclarations.size();
                    System.out.println("------------------------------");
                    System.out.println(n + " type declarations");
                    System.out.println("------------------------------");
                    for (String id: this.typeDeclarations.keySet()){
                        System.out.println(id + " " + this.typeDeclarations.get(id));
                    }
                }
                if (this.formulaDeclarations != null) {
                    int n = this.formulaDeclarations.size();
                    System.out.println("------------------------------");
                    System.out.println(n + " formula declarations");
                    System.out.println("------------------------------");
                    for (String id: this.formulaDeclarations.keySet()){
                        System.out.println(id + " " + this.formulaDeclarations.get(id));
                    }
                }
            }
        }
    }
}