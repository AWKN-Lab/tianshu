package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/awkn-lab/awkn-open-code-review-thin/internal/delegate"
)

const version = "0.1.0-awkn.1"

func main() {
	if len(os.Args) < 3 || os.Args[1] != "delegate" || os.Args[2] != "spec" {
		fmt.Fprintln(os.Stderr, "usage: ocr delegate spec --format json --repo <absolute-path> --from <base-ref> --to <head-ref>")
		os.Exit(2)
	}
	flags := flag.NewFlagSet("delegate spec", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	format := flags.String("format", "", "output format")
	repository := flags.String("repo", "", "absolute repository path")
	from := flags.String("from", "", "base Git reference")
	to := flags.String("to", "", "head Git reference")
	if err := flags.Parse(os.Args[3:]); err != nil {
		os.Exit(2)
	}
	if flags.NArg() != 0 || *format != "json" || *repository == "" || *from == "" || *to == "" {
		fmt.Fprintln(os.Stderr, "delegate spec requires --format json, --repo, --from, and --to")
		os.Exit(2)
	}

	spec, err := delegate.Generate(*repository, *from, *to, version)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ocr delegate spec: %v\n", err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(spec); err != nil {
		fmt.Fprintf(os.Stderr, "encode delegate spec: %v\n", err)
		os.Exit(1)
	}
}
