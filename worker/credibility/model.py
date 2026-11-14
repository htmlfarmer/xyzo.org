"""
Credibility Neural Network
Trains on fact-checked articles to learn factor contributions to accuracy.
Legal: Outputs factor weights, not scores or verdicts.
"""

import json
import math
import pickle
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime
import random

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


@dataclass
class FactorWeight:
    """A credibility factor and its learned weight."""
    name: str
    positive_label: str
    negative_label: str
    weight: float
    bias: float = 0.0

    def describe(self, value: float) -> str:
        """
        Given a normalized input value (0-1), describe the factor contribution.
        Legal: This is an observation, not a verdict.
        """
        contribution = value * self.weight + self.bias
        if contribution > 0.3:
            return self.positive_label
        elif contribution < -0.1:
            return self.negative_label
        return "neutral"


class SimpleNeuralNetwork:
    """
    Simple feedforward NN for credibility factor analysis.
    Uses sigmoid activation, trained via gradient descent.
    """

    def __init__(self, input_size: int, hidden_size: int = 8, output_size: int = 1):
        self.input_size = input_size
        self.hidden_size = hidden_size
        self.output_size = output_size

        scale = 0.1
        self.W1 = [[random.uniform(-scale, scale) for _ in range(input_size)] for _ in range(hidden_size)]
        self.b1 = [0.0] * hidden_size
        self.W2 = [[random.uniform(-scale, scale) for _ in range(hidden_size)] for _ in range(output_size)]
        self.b2 = [0.0] * output_size

        self.training_history = []

    @staticmethod
    def sigmoid(x: float) -> float:
        return 1.0 / (1.0 + math.exp(-max(-500, min(500, x))))

    @staticmethod
    def sigmoid_deriv(x: float) -> float:
        s = SimpleNeuralNetwork.sigmoid(x)
        return s * (1 - s)

    def forward(self, X: List[float]) -> Tuple[List[float], List[float], float]:
        """Forward pass. Returns (hidden activations, output)."""
        hidden = []
        for i in range(self.hidden_size):
            h = self.b1[i]
            for j in range(self.input_size):
                h += self.W1[i][j] * X[j]
            hidden.append(self.sigmoid(h))

        output = self.b2[0]
        for j in range(self.hidden_size):
            output += self.W2[0][j] * hidden[j]
        output = self.sigmoid(output)

        return hidden, output

    def backward(self, X: List[float], hidden: List[float], output: float, target: float, lr: float = 0.01):
        """Backward pass for a single sample."""
        output_delta = (output - target) * self.sigmoid_deriv(output)

        for j in range(self.hidden_size):
            self.W2[0][j] -= lr * output_delta * hidden[j]
        self.b2[0] -= lr * output_delta

        hidden_deltas = [0.0] * self.hidden_size
        for j in range(self.hidden_size):
            hidden_deltas[j] = output_delta * self.W2[0][j] * self.sigmoid_deriv(hidden[j])

        for i in range(self.hidden_size):
            for j in range(self.input_size):
                self.W1[i][j] -= lr * hidden_deltas[i] * X[j]
            self.b1[i] -= lr * hidden_deltas[i]

    def train(self, X_train: List[List[float]], y_train: List[float], epochs: int = 100, lr: float = 0.01) -> List[float]:
        """Train on examples. X_train is list of feature vectors, y_train is 0-1 accuracy labels."""
        losses = []
        for epoch in range(epochs):
            total_loss = 0.0
            for X, y in zip(X_train, y_train):
                hidden, output = self.forward(X)
                self.backward(X, hidden, output, y, lr)
                total_loss += (output - y) ** 2
            avg_loss = total_loss / len(X_train)
            losses.append(avg_loss)
            if epoch % 20 == 0:
                self.training_history.append({"epoch": epoch, "loss": avg_loss})
        return losses

    def predict(self, X: List[float]) -> float:
        """Predict accuracy probability (0-1)."""
        _, output = self.forward(X)
        return output

    def get_factor_importance(self) -> List[float]:
        """Get absolute importance of each input feature (based on hidden layer weights)."""
        importance = [0.0] * self.input_size
        for j in range(self.input_size):
            for i in range(self.hidden_size):
                importance[j] += abs(self.W1[i][j])
        total = sum(importance) or 1.0
        return [v / total for v in importance]


class CredibilityNNTrainer:
    """
    Trains NN on fact-checked articles to learn factor contributions.
    Uses known factual accuracy labels from Snopes, PolitiFact, etc.
    """

    FEATURE_NAMES = [
        "source_accuracy", "source_error_rate", "source_age",
        "source_transparency", "source_expertise",
        "citation_count", "citation_quality",
        "factual_density", "emotional_ratio", "sensationalism",
        "specificity", "verifiability",
        "cross_source_count", "cross_source_credibility",
        "has_author", "has_dateline",
        "word_count_norm", "paragraph_count_norm"
    ]

    def __init__(self):
        self.model = SimpleNeuralNetwork(len(self.FEATURE_NAMES), hidden_size=12)
        self.is_trained = False

    def prepare_features(self, signals: Dict[str, Any]) -> List[float]:
        """Convert CredibilitySignals to normalized feature vector."""
        def norm(val, min_val, max_val):
            return max(0, min(1, (val - min_val) / (max_val - min_val) if max_val > min_val else 0.5))

        features = [
            signals.get("source_historical_accuracy", 0.5),
            signals.get("source_error_rate", 0.0),
            min(signals.get("source_age_years", 0), 100) / 100,
            signals.get("source_transparency_score", 0.5),
            signals.get("source_topic_expertise", 0.0),
            min(signals.get("citation_count", 0), 20) / 20,
            signals.get("citation_quality_score", 0.5),
            signals.get("factual_density", 0.0),
            signals.get("emotional_language_ratio", 0.0),
            signals.get("sensationalism_score", 0.0),
            signals.get("specificity_score", 0.5),
            signals.get("claim_verifiability", 0.0),
            min(signals.get("cross_source_count", 0), 20) / 20,
            signals.get("cross_source_credibility_avg", 0.5),
            1.0 if signals.get("has_author") else 0.0,
            1.0 if signals.get("has_dateline") else 0.0,
            min(signals.get("word_count", 0), 3000) / 3000,
            min(signals.get("paragraph_count", 0), 50) / 50,
        ]
        return features

    def generate_synthetic_training_data(self) -> Tuple[List[List[float]], List[float]]:
        """
        Generate synthetic training data based on known relationships.
        In production, this would use actual fact-checked article data.
        """
        X = []
        y = []

        for _ in range(5000):
            source_acc = random.uniform(0.3, 0.95)
            citation_q = random.uniform(0.1, 0.95)
            factual = random.uniform(0.02, 0.35)
            emotional = random.uniform(0.0, 0.15)
            sens = random.uniform(0.0, 0.5)

            features = [
                source_acc,
                random.uniform(0.0, 0.3),
                random.uniform(0, 50) / 100,
                random.uniform(0.2, 0.9),
                random.uniform(0.1, 0.9),
                random.uniform(0, 15) / 20,
                citation_q,
                factual,
                emotional,
                sens,
                random.uniform(0.2, 0.9),
                random.uniform(0.0, 0.8),
                random.uniform(0, 10) / 20,
                random.uniform(0.3, 0.95),
                random.choice([0, 1]),
                random.choice([0, 1]),
                random.uniform(200, 2000) / 3000,
                random.uniform(2, 20) / 50,
            ]

            accuracy = (
                source_acc * 0.25 +
                citation_q * 0.15 +
                factual * 0.2 +
                (1 - emotional) * 0.1 +
                (1 - sens) * 0.1 +
                features[3] * 0.1 +
                random.uniform(-0.1, 0.1)
            )
            accuracy = max(0.0, min(1.0, accuracy))
            X.append(features)
            y.append(accuracy)

        return X, y

    def train(self, X: Optional[List[List[float]]] = None, y: Optional[List[float]] = None, epochs: int = 150) -> Dict[str, Any]:
        """Train the model."""
        if X is None or y is None:
            X, y = self.generate_synthetic_training_data()

        losses = self.model.train(X, y, epochs=epochs, lr=0.05)
        self.is_trained = True

        importance = self.model.get_factor_importance()
        feature_weights = dict(zip(self.FEATURE_NAMES, importance))

        return {
            "trained": True,
            "samples": len(X),
            "epochs": epochs,
            "final_loss": losses[-1] if losses else None,
            "feature_importance": feature_weights,
            "training_curve": losses[::10] if len(losses) > 10 else losses
        }

    def predict_factors(self, signals: Dict[str, Any]) -> Dict[str, Any]:
        """
        Predict factor contributions to accuracy.
        Legal: Returns factor analysis, NOT a credibility score.
        """
        if not self.is_trained:
            self.train()

        features = self.prepare_features(signals)
        raw_prediction = self.model.predict(features)

        importance = self.model.get_factor_importance()

        factor_analysis = []
        for i, (name, importance_score) in enumerate(zip(self.FEATURE_NAMES, importance)):
            value = features[i]
            factor_analysis.append({
                "factor": name,
                "importance": round(importance_score, 3),
                "value": round(value, 3),
                "contribution": "high" if importance_score > 0.08 else "medium" if importance_score > 0.04 else "low"
            })

        factor_analysis.sort(key=lambda x: x["importance"], reverse=True)

        return {
            "factors": factor_analysis,
            "note": "Analysis shows which factors most strongly correlate with factual accuracy in similar articles. This is informational only - evaluate the factors yourself."
        }

    def save(self, path: str):
        """Save model to disk."""
        with open(path, 'wb') as f:
            pickle.dump({
                'W1': self.model.W1,
                'b1': self.model.b1,
                'W2': self.model.W2,
                'b2': self.model.b2,
                'training_history': self.model.training_history
            }, f)

    def load(self, path: str):
        """Load model from disk."""
        with open(path, 'rb') as f:
            data = pickle.load(f)
        self.model.W1 = data['W1']
        self.model.b1 = data['b1']
        self.model.W2 = data['W2']
        self.model.b2 = data['b2']
        self.model.training_history = data.get('training_history', [])
        self.is_trained = True


def create_default_trainer() -> CredibilityNNTrainer:
    """Create and train a default credibility trainer."""
    trainer = CredibilityNNTrainer()
    result = trainer.train(epochs=150)
    return trainer
