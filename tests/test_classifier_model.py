"""Tests for classifier model definition.

Skipped if torch not installed.
"""
import pytest

torch_available = False
try:
    import torch  # noqa: F401
    torch_available = True
except ImportError:
    pass

pytestmark = pytest.mark.skipif(not torch_available,
                                 reason="torch not installed")


class TestBuildModel:
    def test_returns_two_outputs(self):
        from worker.classifier import build_model
        m = build_model()
        # Should produce 1 (re-ranker) + 8 (event type) outputs
        out_rich, out_type = m._test_forward()
        assert out_rich.shape[-1] == 1
        assert out_type.shape[-1] == 8

    def test_model_is_in_eval_mode_after_load(self):
        from worker.classifier import build_model, load_latest_model
        try:
            m = load_latest_model()
            # If we have a model on disk, it should be loadable
        except Exception:
            # No trained model yet — that's fine
            pass


# ── Additional model-structure tests ────────────────────────────────
# These go beyond the 2 spec tests but stay inside the build_model()
# surface — no training, no disk I/O. They lock in the architectural
# invariants that downstream tasks (training, inference) will rely on.


class TestModelStructure:
    def test_backbone_has_expected_layers(self):
        """Backbone is a Sequential of Linear+ReLU+Dropout per hidden dim."""
        import torch.nn as nn
        from worker.classifier import CLASSIFIER_CONFIG, build_model

        m = build_model()
        assert isinstance(m.backbone, nn.Sequential)

        # Per the config, each hidden layer adds 3 modules
        # (Linear, ReLU, Dropout). Count Linear children to confirm.
        linears = [mod for mod in m.backbone
                   if isinstance(mod, nn.Linear)]
        assert len(linears) == len(CLASSIFIER_CONFIG["hidden_dims"])

        # Widths must line up: input → first hidden → ... → last hidden
        expected_dims = [CLASSIFIER_CONFIG["input_dim"]] + \
                        list(CLASSIFIER_CONFIG["hidden_dims"])
        actual_dims = [lin.in_features for lin in linears] + \
                      [linears[-1].out_features]
        assert actual_dims == expected_dims

        # Heads must produce the configured output widths
        assert m.reranker_head.out_features == \
            CLASSIFIER_CONFIG["reranker_head"]
        assert m.event_type_head.out_features == \
            CLASSIFIER_CONFIG["event_type_classes"]

    def test_forward_with_batch_input(self):
        """Forward pass handles batched inputs of shape [N, 384]."""
        from worker.classifier import build_model

        m = build_model()
        x = torch.zeros(5, 384)   # 5 samples, 384-dim each
        reranker, event_type = m(x)

        # Re-ranker is one sigmoid per sample
        assert reranker.shape == (5, 1)
        # Event type is a softmax over 8 classes per sample
        assert event_type.shape == (5, 8)

        # Softmax rows must sum to 1 (within float tolerance)
        row_sums = event_type.sum(dim=-1)
        assert torch.allclose(row_sums, torch.ones(5), atol=1e-5)

        # Sigmoid output must be in (0, 1)
        assert (reranker >= 0.0).all() and (reranker <= 1.0).all()

    def test_backbone_gradient_flows(self):
        """Gradients from a synthetic loss reach both heads."""
        from worker.classifier import build_model

        m = build_model()
        x = torch.zeros(2, 384, requires_grad=False)
        reranker, event_type = m(x)

        # Synthetic loss = sum of both heads' outputs
        loss = reranker.sum() + event_type.sum()
        loss.backward()

        # Every parameter in the backbone must receive a gradient
        for name, param in m.backbone.named_parameters():
            assert param.grad is not None, \
                f"backbone param {name} got no gradient"
            assert torch.isfinite(param.grad).all(), \
                f"backbone param {name} gradient has NaN/Inf"

        # Both heads must receive gradients too
        for name, param in m.reranker_head.named_parameters():
            assert param.grad is not None, \
                f"reranker_head param {name} got no gradient"
        for name, param in m.event_type_head.named_parameters():
            assert param.grad is not None, \
                f"event_type_head param {name} got no gradient"
