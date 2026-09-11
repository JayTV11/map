"""Common interface both ingestion sources implement.

Whatever the source, its only job is to keep calling publish(event) with
a TrafficEvent -- the broadcaster and the frontend don't know or care
which subclass produced it. That's the core architectural unification:
one contract, two very different producers behind it.
"""
from __future__ import annotations

import abc
from typing import Awaitable, Callable

from ..models import TrafficEvent

Publisher = Callable[[TrafficEvent], Awaitable[None]]


class EventSource(abc.ABC):
    @abc.abstractmethod
    async def run(self, publish: Publisher) -> None:
        """Run forever (until cancelled), calling publish() for each event."""
        raise NotImplementedError

    @abc.abstractmethod
    async def stop(self) -> None:
        raise NotImplementedError
