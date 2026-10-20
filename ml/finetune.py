"""LoRA fine-tune of a small open-weight model on Tinker, then sampling on the test split.

Only synthetic data is sent: the prompt/reply pairs from scripts/export-sft.ts,
built from eval/cases.jsonl. Real files never leave the machine.

The model's replies on the test prompts are written to a JSONL file, and
`dz eval --provider replay --replies <file>` scores them through the same
parsing, validation, and date grounding as every other model.

    uv run python finetune.py data/sft.jsonl --out ../eval/replies/qwen3.5-4b-lora.jsonl
    uv run python finetune.py data/sft.jsonl --no-train --out ../eval/replies/qwen3.5-4b-base.jsonl
"""

from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

import tinker
from tinker import types


def chat_prompt(tokenizer, prompt: str) -> list[int]:
    text = tokenizer.apply_chat_template(
        [{"role": "user", "content": prompt}],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    return tokenizer.encode(text, add_special_tokens=False)


def make_datum(tokenizer, prompt: str, reply: str, end: str) -> types.Datum:
    """Next-token prediction on the reply only; the prompt tokens carry no loss."""
    prompt_ids = chat_prompt(tokenizer, prompt)
    reply_ids = tokenizer.encode(reply + end, add_special_tokens=False)
    tokens = prompt_ids + reply_ids
    weights = [0.0] * len(prompt_ids) + [1.0] * len(reply_ids)
    return types.Datum(
        model_input=types.ModelInput.from_ints(tokens[:-1]),
        loss_fn_inputs={"target_tokens": tokens[1:], "weights": weights[1:]},
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pairs", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--base", default="Qwen/Qwen3.5-4B")
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--no-train", action="store_true", help="sample the base model as is (the baseline)")
    args = parser.parse_args()

    pairs = [json.loads(line) for line in args.pairs.read_text().splitlines() if line]
    train = [p for p in pairs if p["split"] == "train"]
    test = [p for p in pairs if p["split"] == "test"]

    service = tinker.ServiceClient()
    training = service.create_lora_training_client(base_model=args.base, rank=args.rank)
    tokenizer = training.get_tokenizer()
    end = "<|im_end|>"  # Qwen's end-of-turn token, so the model learns to stop after the JSON

    if not args.no_train:
        data = [make_datum(tokenizer, p["prompt"], p["reply"], end) for p in train]
        rng = random.Random(0)
        for epoch in range(args.epochs):
            rng.shuffle(data)
            losses = []
            for start in range(0, len(data), args.batch):
                batch = data[start : start + args.batch]
                backward = training.forward_backward(batch, "cross_entropy")
                step = training.optim_step(types.AdamParams(learning_rate=args.lr))
                result = backward.result()
                step.result()
                # Mean loss per reply token in this batch.
                total = sum(
                    -(out["logprobs"].to_numpy() * d.loss_fn_inputs["weights"].to_numpy()).sum()
                    for out, d in zip(result.loss_fn_outputs, batch)
                )
                tokens = sum(d.loss_fn_inputs["weights"].to_numpy().sum() for d in batch)
                losses.append(total / tokens)
            print(f"epoch {epoch + 1}: loss {sum(losses) / len(losses):.4f}", flush=True)

    sampler = training.save_weights_and_get_sampling_client()
    params = types.SamplingParams(max_tokens=400, temperature=0.0, stop=[end])

    # One request at a time, so each latency is a single round trip, as in the app.
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as out:
        for p in test:
            started = time.perf_counter()
            prompt = types.ModelInput.from_ints(chat_prompt(tokenizer, p["prompt"]))
            response = sampler.sample(prompt, 1, params).result()
            ms = (time.perf_counter() - started) * 1000
            raw = tokenizer.decode(response.sequences[0].tokens, skip_special_tokens=True)
            out.write(json.dumps({"id": p["id"], "prompt": p["prompt"], "raw": raw, "ms": round(ms)}, ensure_ascii=False) + "\n")
    label = args.base + ("" if args.no_train else f" + LoRA r{args.rank}, {args.epochs} epochs on {len(train)} synthetic cases")
    print(f"{label}: wrote {len(test)} replies to {args.out}")


if __name__ == "__main__":
    main()
